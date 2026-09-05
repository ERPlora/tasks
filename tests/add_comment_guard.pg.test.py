#!/usr/bin/env python3
"""Commenting on a task that is not yours must be a business error, not a Postgres one
(ERPlora/tasks#24).

WHAT WAS WRONG. `commands/add_comment.sql` was an `INSERT … VALUES` that leaned on the foreign key
`tasks_comment_task_id_fkey` to reject an unknown task. Integrity held — nothing was written and no
event was emitted — but the caller got the driver's own words back:

    {"ok":false,"error":{"code":"error","message":"db: sqlx: error returned from database:
     insert or update on table \\"tasks_comment\\" violates foreign key constraint
     \\"tasks_comment_task_id_fkey\\" at line 2772"}}

`"code": "error"` is not a stable code: the UI, the assistant and any integration cannot tell «that
task does not exist» from any other database failure, so they end up printing the driver's text —
which also publishes the engine, its access layer, the table, the constraint and an internal line
number.

AND THE HALF THE FK NEVER COVERED. A foreign key checks that the ROW exists, not WHOSE it is. So
the two cases below were not rejected at all — they were written, successfully, and the event was
emitted:

  * a `task_id` belonging to ANOTHER hub — the comment landed with our `hub_id` pointing at a
    neighbour's task;
  * a SOFT-DELETED task — `is_deleted` is not part of any constraint.

That is the reason the fix is the `INSERT … SELECT` and not merely a nicer error message: the
`WHERE` is what scopes the check to this hub, and the FK never could.

WHAT THIS PINS: the manifest declares the gate with a stable translated code, and against a real
Postgres the statement writes exactly one row for a live task of THIS hub and exactly zero — with
no database error — for the three ways of not being that.

Usage: tests/add_comment_guard.pg.test.py   (exit 0 = green)
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

COMMAND = "tasks.tasks.add_comment"
SQL_FILE = "commands/add_comment.sql"

# The strings that must never reach a caller. Straight from the issue's acceptance criteria.
LEAKY = ("sqlx", "constraint", "db:", "_fkey")

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def check_manifest_declares_the_gate() -> None:
    spec = MANIFEST["commands"][COMMAND]
    files = spec["sql"] if isinstance(spec["sql"], list) else [spec["sql"]]
    if SQL_FILE not in files:
        fail(f"{COMMAND} no longer runs {SQL_FILE}: {files}")

    gate = spec.get("expect_rows")
    if not gate:
        fail(
            f"`{COMMAND}` has no `expect_rows`: the rejection can only come from the foreign key, "
            "i.e. as the driver's raw text with an unstable code (tasks#24)"
        )
        return
    if gate.get("op") != "min" or gate.get("n", 0) < 1:
        fail(f"`{COMMAND}` gate must require at least one row, got {gate!r}")

    code = gate.get("error", "")
    if not code.startswith("tasks."):
        fail(f"`{COMMAND}` gate code `{code}` is not namespaced to this module")

    message = gate.get("message", "")
    for leak in LEAKY:
        if leak in message.lower():
            fail(f"`{COMMAND}` gate message leaks internals (`{leak}`): {message!r}")

    # ADR-0398 + hub#1570: the code is DECLARED in `module.json → errors`, and its sentence lives
    # under the COMPLETE code in `locales/<lang>.json → errors` — flat, never grouped by module.
    # The hub's SDK indexes first-level `<module>.<snake_case>` keys only (hub#1573), so a nested
    # bucket reads as "nobody translated this" and a Spanish till keeps the server's English.
    if code not in (MANIFEST.get("errors") or {}):
        fail(f"module.json → errors does not declare `{code}` (ADR-0398)")

    for lang in ("en", "es"):
        catalog = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text())
        text = (catalog.get("errors") or {}).get(code)
        if not isinstance(text, str) or not text.strip():
            fail(
                f"locales/{lang}.json has no `errors.{code}` — the UI would show the raw code"
            )


def comment_count(db) -> int:
    return int(db.scalar("SELECT count(*) FROM tasks_comment"))


def check_behaviour(db) -> None:
    live = "task-live"
    other = "task-of-another-hub"
    gone = "task-soft-deleted"
    pg.seed_task(db, live, number="TSK-1")
    pg.seed_task(db, other, number="TSK-2", hub=pg.OTHER_HUB)
    pg.seed_task(db, gone, number="TSK-3", deleted=1)

    # --- check the check: commenting a REAL task must work, or every rejection below is vacuous.
    try:
        affected = db.run_command(
            COMMAND, {"task_id": live, "comment": "hola", "author_ref": None}
        )
    except pg.CommandRejected as exc:
        fail(
            f"commenting a REAL task was rejected as `{exc.code}` — the gate is too tight"
        )
        return
    except RuntimeError as exc:
        fail(
            f"commenting a REAL task raised a database error — the fix broke the happy path: {exc}"
        )
        return
    if affected != 1:
        fail(f"commenting a real task affected {affected} rows, expected 1")
    if comment_count(db) != 1:
        fail("commenting a real task stored no comment — the check proves nothing")
        return
    if (
        db.scalar(f"SELECT comment FROM tasks_comment WHERE task_id = '{live}'")
        != "hola"
    ):
        fail("the stored comment is not the one that was sent")

    # --- the bug: none of these may write, and none may answer with the driver's voice. ---------
    for label, task_id in (
        ("a task_id that does not exist", "fantasma"),
        ("a task belonging to another hub", other),
        ("a soft-deleted task", gone),
    ):
        before = comment_count(db)
        try:
            affected = db.run_command(
                COMMAND, {"task_id": task_id, "comment": "hola", "author_ref": None}
            )
        except pg.CommandRejected as exc:
            if exc.code != "tasks.task_not_found":
                fail(
                    f"{label}: rejected with `{exc.code}`, expected `tasks.task_not_found`"
                )
        except RuntimeError as exc:
            text = str(exc).lower()
            leaked = [w for w in LEAKY if w in text]
            fail(
                f"{label}: the statement raised a DATABASE error instead of being a clean no-op"
                + (f" and it leaks {leaked} to the caller" if leaked else "")
                + f" (tasks#24): {str(exc)[:160]}"
            )
        else:
            fail(
                f"{label}: the comment was WRITTEN ({affected} row) — the foreign key never checked "
                f"hub_id nor is_deleted, so this crossed into another business (tasks#24)"
            )
        after = comment_count(db)
        if after != before:
            fail(
                f"{label}: {after - before} comment row(s) written; nothing should have been"
            )


def main() -> int:
    check_manifest_declares_the_gate()

    if not pg.container_available():
        print(
            f"SKIPPED: no Postgres in container {pg.CONTAINER} (nothing was verified)"
        )
        return 1 if failures else 0

    db = pg.ScratchDb("tasks_add_comment_guard")
    db.create()
    try:
        check_behaviour(db)
    finally:
        db.drop()

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        "OK: a comment is written only on a live task of this hub, and refused with a stable code otherwise"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
