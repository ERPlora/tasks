#!/usr/bin/env python3
"""`tasks.tasks.assign` must not report success — nor emit — for a task that does not exist
(ERPlora/tasks#22).

WHAT WAS WRONG. `tasks.tasks.assign` was the ONE write command of this module carrying `emit` and
no row gate. Its SQL is an `UPDATE … WHERE id = :task_id AND hub_id = :hub_id AND is_deleted = 0`,
so an unknown id matches nothing, the UPDATE affects zero rows — and with nobody weighing that
count the runtime called the transaction good and published `tasks.task.assigned`. A caller got
`200 {"ok": true}` and an integration got an assignment event for a task that is nowhere. The
payload schema could never have caught it: it validates the SHAPE of `task_id`, not its existence.

The asymmetry was inside this same module: `tasks.tasks.add_comment` on an unknown task was already
refused. Comment protected, assign not.

WHAT THIS PINS, in the two halves a module repo can actually pin:

  1. the manifest declares the gate (`expect_rows`), with a stable namespaced code the UI can
     translate (ADR-0055) and an entry for it in BOTH locale catalogues;
  2. against a real Postgres, the SQL really is a no-op for every "not this task" case — unknown
     id, another hub's task, a soft-deleted one — and really does affect exactly one row on the
     happy paths (assign AND unassign), so the gate fires on precisely the right cases.

Together those are the 409: the runtime rolls back the whole transaction, outbox included, when the
count is under the gate. The 409 itself is the runtime's own test, not this repo's.

Usage: tests/assign_guard.pg.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: TASKS_TEST_PG_CONTAINER).
"""

import importlib.util
import json
import pathlib
import sys

_HARNESS = pathlib.Path(__file__).resolve().parent / "pg_harness.py"
_spec = importlib.util.spec_from_file_location("pg_harness", _HARNESS)
pg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pg)

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = pg.MANIFEST

COMMAND = "tasks.tasks.assign"
SQL_FILE = "commands/assign_task.sql"

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def check_manifest_declares_the_gate() -> None:
    """The contract half: a write command that emits must say how many rows make it true."""
    spec = MANIFEST["commands"][COMMAND]

    if not spec.get("emit"):
        fail(
            f"`{COMMAND}` no longer emits — this battery's premise is gone, rewrite it"
        )
        return

    gate = spec.get("expect_rows")
    if not gate:
        fail(
            f"`{COMMAND}` emits {spec['emit']} with no `expect_rows`: an unknown task_id updates "
            "0 rows, the runtime commits anyway and publishes a phantom assignment (tasks#22)"
        )
        return

    if gate.get("op") != "min" or gate.get("n", 0) < 1:
        fail(f"`{COMMAND}` gate must require at least one row, got {gate!r}")

    code = gate.get("error", "")
    if not code.startswith("tasks."):
        fail(
            f"`{COMMAND}` gate code `{code}` is not namespaced to this module (the installer rejects it)"
        )

    for lang in ("en", "es"):
        catalog = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text())
        module_id, _, key = code.partition(".")
        if key not in catalog.get("errors", {}).get(module_id, {}):
            fail(
                f"locales/{lang}.json has no `errors.{code}` — the UI would show the raw code"
            )


def check_sql_is_still_the_one_under_test(db) -> None:
    spec = MANIFEST["commands"][COMMAND]
    files = spec["sql"] if isinstance(spec["sql"], list) else [spec["sql"]]
    if SQL_FILE not in files:
        fail(f"{COMMAND} no longer runs {SQL_FILE}: {files}")


def check_behaviour(db) -> None:
    """The behavioural half: which calls touch a row, and which touch none."""
    live = "task-live"
    other = "task-of-another-hub"
    gone = "task-soft-deleted"
    pg.seed_task(db, live, number="TSK-1")
    pg.seed_task(db, other, number="TSK-2", hub=pg.OTHER_HUB)
    pg.seed_task(db, gone, number="TSK-3", deleted=1)

    # --- check the check: the fixture is really there, and a real assign really moves it. -------
    if db.scalar(f"SELECT count(*) FROM tasks_task WHERE id = '{live}'") != "1":
        fail(
            "fixture missing: the seeded task is not in the scratch database — check is vacuous"
        )
        return

    try:
        affected = db.run_command(
            COMMAND, {"task_id": live, "assigned_to_ref": "u-alice"}
        )
    except pg.CommandRejected as exc:
        fail(
            f"assigning a REAL task was rejected as `{exc.code}` — the gate is too tight"
        )
        return
    if affected != 1:
        fail(f"assigning a real task affected {affected} rows, expected 1")
    if (
        db.scalar(f"SELECT assigned_to_ref FROM tasks_task WHERE id = '{live}'")
        != "u-alice"
    ):
        fail(
            "assigning a real task did not store the assignee — the check proves nothing"
        )
        return

    # Unassigning is the same command with a null ref, and it must stay a success.
    try:
        affected = db.run_command(COMMAND, {"task_id": live, "assigned_to_ref": None})
    except pg.CommandRejected as exc:
        fail(
            f"UNassigning a real task was rejected as `{exc.code}` — the gate broke a happy path"
        )
    else:
        if affected != 1:
            fail(f"unassigning affected {affected} rows, expected 1")
        if (
            db.scalar(
                f"SELECT assigned_to_ref IS NULL FROM tasks_task WHERE id = '{live}'"
            )
            != "t"
        ):
            fail("unassigning did not clear the assignee")

    # --- the bug: every "not this task" call must be refused, not silently committed. -----------
    for label, task_id, hub in (
        ("a task_id that does not exist", "fantasma-total", pg.HUB),
        ("a task belonging to another hub", other, pg.HUB),
        ("a soft-deleted task", gone, pg.HUB),
    ):
        try:
            affected = db.run_command(
                COMMAND, {"task_id": task_id, "assigned_to_ref": "u-alice"}, hub=hub
            )
        except pg.CommandRejected as exc:
            if exc.code != "tasks.task_not_found":
                fail(
                    f"{label}: rejected with `{exc.code}`, expected `tasks.task_not_found`"
                )
            continue
        fail(
            f"{label}: assign reported success ({affected} rows) and the runtime would emit "
            f"{MANIFEST['commands'][COMMAND]['emit']} for a task that is not there (tasks#22)"
        )


def main() -> int:
    check_manifest_declares_the_gate()

    if not pg.container_available():
        print(
            f"SKIPPED: no Postgres in container {pg.CONTAINER} (nothing was verified)"
        )
        return 1 if failures else 0

    db = pg.ScratchDb("tasks_assign_guard")
    db.create()
    try:
        check_sql_is_still_the_one_under_test(db)
        check_behaviour(db)
    finally:
        db.drop()

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        "OK: assign only succeeds on a task of this hub that exists, and is gated when it does not"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
