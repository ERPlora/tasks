"""Shared plumbing for this module's Postgres batteries — the runtime dispatcher, in miniature.

Runs the manifest's OWN SQL against a REAL Postgres 18 (the workspace's `erplora-test-pg-5433`
container), building a scratch database from this module's own migrations and DROPPING it at the
end, pass or fail. Same shape as the harness `services`, `staff` and `schedules` already carry —
copied rather than invented so a reader who knows one knows all of them.

What is reproduced of the dispatcher, and only that:

  * `:name` placeholders bound as literals in ONE pass (a value carrying a colon — an ISO
    timestamp — is never rescanned);
  * params absent from the payload bind as NULL (`DynNull`, `hub/crates/db/src/lib.rs`);
  * a command's `sql[]` runs inside one BEGIN/COMMIT with the system params (`hub_id`,
    `current_user_id`, `now`, one `new_id` per statement) injected;
  * the **rows affected** are counted the way `commands.rs` counts them (the sum over the
    statements) and weighed against the manifest's `expect_rows` gate.

What is NOT reproduced, said out loud instead of faked:

  * JSON Schema validation of the payload (that is a contract battery's job);
  * the transactional outbox — no `_event_outbox` table exists here. What the batteries CAN pin is
    the gate that decides whether the runtime ever gets to write one: below `expect_rows.n` the
    runtime rolls the whole transaction back, outbox included, so "the gate rejected" is exactly
    "no event was emitted". `CommandRejected` is that verdict.
  * the ROLLBACK itself. `run_command` commits and then weighs the count, which is observably the
    same thing in the case these batteries exercise — a rejected command here affects 0 rows, so
    there is nothing for a rollback to undo. A test that asserts a rejection AND a write would be
    lying about this harness, so don't write one.
"""

import json
import os
import pathlib
import re
import subprocess
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
CONTAINER = os.environ.get("TASKS_TEST_PG_CONTAINER", "erplora-test-pg-5433")
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

HUB = "hub-under-test"
OTHER_HUB = "hub-next-door"
USER = "u-owner"
NOW = "2026-08-18T10:00:00Z"

PARAM = re.compile(r":([a-z_][a-z0-9_]*)", re.IGNORECASE)

# psql echoes a command tag per statement: `UPDATE 3`, `INSERT 0 1`, `DELETE 0`. That is the only
# place the affected-row count is observable from outside the session, and it is what the runtime
# sums. `BEGIN`/`COMMIT` carry no count and are ignored by construction (the regex needs digits).
TAG = re.compile(
    r"^(?:INSERT\s+\d+\s+(\d+)|UPDATE\s+(\d+)|DELETE\s+(\d+))\s*$", re.MULTILINE
)


class CommandRejected(RuntimeError):
    """The manifest's `expect_rows` gate refused the mutation — HTTP 409 with a stable code."""

    def __init__(self, code: str, affected: int, expected: int):
        super().__init__(f"{code} (affected {affected}, expected at least {expected})")
        self.code = code
        self.affected = affected
        self.expected = expected


def container_available() -> bool:
    try:
        subprocess.run(
            ["docker", "inspect", CONTAINER], capture_output=True, check=True, text=True
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return PARAM.sub(lambda m: literal(params.get(m.group(1))), sql)


def affected_rows(psql_output: str) -> int:
    """Sum of the command tags psql echoed — what `commands.rs` compares against `expect_rows`."""
    return sum(
        int(next(g for g in m.groups() if g is not None))
        for m in TAG.finditer(psql_output)
    )


class ScratchDb:
    """A throwaway database built from the manifest's Postgres migrations."""

    def __init__(self, prefix: str):
        self.name = f"{prefix}_{os.getpid()}_{uuid.uuid4().hex[:6]}"

    def psql(
        self, args: list[str], db: str | None = None, stdin: str | None = None
    ) -> str:
        cmd = [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            "postgres",
            "-X",
        ]
        if db:
            cmd += ["-d", db]
        cmd += args
        res = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(res.stderr.strip() or res.stdout.strip())
        return res.stdout

    def create(self) -> None:
        self.psql(["-c", f'DROP DATABASE IF EXISTS "{self.name}"'])
        self.psql(["-c", f'CREATE DATABASE "{self.name}"'])
        for rel in MANIFEST["migrations"]["postgres"]:
            self.psql([], db=self.name, stdin=(MODULE_DIR / rel).read_text())

    def drop(self) -> None:
        try:
            self.psql(["-c", f'DROP DATABASE IF EXISTS "{self.name}" WITH (FORCE)'])
        except RuntimeError as exc:
            print(f"  ! could not drop {self.name}: {exc}")

    def scalar(self, sql: str) -> str:
        return self.psql(["-tAc", sql], db=self.name).strip()

    def exec_script(self, sql: str) -> None:
        self.psql([], db=self.name, stdin=sql)

    def run_command(self, name: str, payload: dict, hub: str = HUB) -> int:
        """Execute a manifest command's `sql[]` as the runtime does, and apply its `expect_rows`.

        Returns the rows affected. Raises `CommandRejected` when the manifest declares a gate the
        mutation did not clear — which is where the runtime answers 409 and writes no event.
        """
        cmd = MANIFEST["commands"][name]
        params = dict(payload)
        params.setdefault("hub_id", hub)
        params.setdefault("current_user_id", USER)
        params.setdefault("now", NOW)
        script = ["BEGIN;"]
        for rel in cmd["sql"]:
            stmt_params = dict(params)
            stmt_params.setdefault("new_id", str(uuid.uuid4()))
            script.append(bind((MODULE_DIR / rel).read_text(), stmt_params))
        script.append("COMMIT;")
        affected = affected_rows(self.psql([], db=self.name, stdin="\n".join(script)))

        gate = cmd.get("expect_rows")
        if gate and gate.get("op") == "min" and affected < gate["n"]:
            raise CommandRejected(gate["error"], affected, gate["n"])
        return affected


def seed_task(
    db: ScratchDb,
    task_id: str,
    *,
    hub: str = HUB,
    number: str = "TSK-1",
    assigned_to: str | None = None,
    deleted: int = 0,
) -> None:
    """One task row, straight in — the fixture, not the thing under test."""
    db.exec_script(
        "INSERT INTO tasks_task (id, hub_id, task_number, title, assigned_to_ref, "
        "is_deleted, created_at) VALUES ("
        f"{literal(task_id)}, {literal(hub)}, {literal(number)}, 'Fixture', "
        f"{literal(assigned_to)}, {deleted}, {literal(NOW)});"
    )
