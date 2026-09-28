#!/usr/bin/env python3
"""«My tasks» must keep its cards where they are when one of them changes (ERPlora/tasks#45).

WHAT WAS WRONG. `tasks.tasks.my` ordered by `due_date` ALONE. Most tasks carry no due date, so
every one of them tied — and Postgres hands tied rows back in whatever order the scan meets them.
An UPDATE writes a new row version at the end of the heap, so pressing «Start» on the first card
(or assigning it, or anything else that writes the row) sent it to the BOTTOM of the list on the
next reload: the card vanished from under the finger and another task sat in its slot.

WHAT THIS PINS, against a real Postgres, with the manifest's OWN SQL:

  1. the order is total and the one the screen promises: tasks with a due date first, soonest first;
     then the undated ones, newest first (the same «newest first» as the «All» tab); the id breaks
     any remaining tie;
  2. writing a row — the very `_set_status.sql` intent «Start» runs — does not move it;
  3. the list is still this person's OPEN tasks of THIS hub only (done/cancelled, another person's
     and another hub's rows stay out).

Usage: tests/my_tasks_order.pg.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: TASKS_TEST_PG_CONTAINER).
"""

import importlib.util
import pathlib
import sys

_HARNESS = pathlib.Path(__file__).resolve().parent / "pg_harness.py"
_spec = importlib.util.spec_from_file_location("pg_harness", _HARNESS)
pg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pg)

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
QUERY = "tasks.tasks.my"
ME = "u-me"

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def seed(
    db,
    task_id: str,
    created_at: str,
    *,
    due: str | None = None,
    status: str = "todo",
    assigned_to: str = ME,
    hub: str = pg.HUB,
) -> None:
    lit = pg.literal
    db.exec_script(
        "INSERT INTO tasks_task (id, hub_id, task_number, title, status, priority, "
        "assigned_to_ref, due_date, is_deleted, created_at) VALUES ("
        f"{lit(task_id)}, {lit(hub)}, {lit('TSK-' + task_id)}, {lit(task_id)}, {lit(status)}, "
        f"'medium', {lit(assigned_to)}, {lit(due)}, 0, {lit(created_at)});"
    )


def my_tasks(db) -> list[str]:
    sql = (MODULE_DIR / pg.MANIFEST["queries"][QUERY]["sql"]).read_text()
    bound = pg.bind(
        sql,
        {
            "hub_id": pg.HUB,
            "assigned_to_ref": ME,
            "apply_horizon": 0,
            "due_horizon": None,
        },
    )
    out = db.psql(["-tA"], db=db.name, stdin=bound)
    return [line for line in out.splitlines() if line.strip()]


def ids(db) -> list[str]:
    return [row.split("|", 1)[0] for row in my_tasks(db)]


def start(db, task_id: str) -> None:
    """What «Start» on a card runs: the handler's `_set_status.sql` intent."""
    sql = (MODULE_DIR / "commands/_set_status.sql").read_text()
    db.exec_script(
        pg.bind(
            sql,
            {
                "task_id": task_id,
                "new_status": "in_progress",
                "hub_id": pg.HUB,
                "current_user_id": ME,
                "now": "2026-09-28T12:00:00Z",
            },
        )
    )


def check_order(db) -> None:
    # Created in this order; ONE of them has a due date, the rest tie on «no due date».
    seed(db, "t-old", "2026-09-26T08:00:00Z")
    seed(db, "t-mid", "2026-09-26T09:00:00Z")
    seed(db, "t-new", "2026-09-26T10:00:00Z")
    seed(db, "t-due", "2026-09-26T07:00:00Z", due="2026-09-30")
    seed(db, "t-due-soon", "2026-09-26T07:30:00Z", due="2026-09-29")
    # Same instant as t-mid: only the id can tell them apart.
    seed(db, "t-mid-twin", "2026-09-26T09:00:00Z")
    # Must never show up in «My tasks».
    seed(db, "x-done", "2026-09-26T11:00:00Z", status="done")
    seed(db, "x-cancelled", "2026-09-26T11:00:00Z", status="cancelled")
    seed(db, "x-someone-else", "2026-09-26T11:00:00Z", assigned_to="u-other")
    seed(db, "x-other-hub", "2026-09-26T11:00:00Z", hub=pg.OTHER_HUB)

    expected = ["t-due-soon", "t-due", "t-new", "t-mid", "t-mid-twin", "t-old"]
    got = ids(db)
    if got != expected:
        fail(f"«My tasks» order: expected {expected}, got {got}")

    for task_id in ("t-new", "t-due-soon", "t-mid"):
        start(db, task_id)
        after = ids(db)
        if after != expected:
            fail(
                f"starting {task_id} moved the cards: before {expected}, after {after} "
                "(the card leaves the screen and another one sits in its slot — tasks#45)"
            )


def main() -> int:
    if not pg.container_available():
        print(
            f"SKIPPED: no Postgres in container {pg.CONTAINER} (nothing was verified)"
        )
        return 1

    db = pg.ScratchDb("tasks_my_order")
    db.create()
    try:
        check_order(db)
    finally:
        db.drop()

    if failures:
        print(f"FAIL ({len(failures)}):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("OK: «My tasks» has a total order and a write does not move a card")
    return 0


if __name__ == "__main__":
    sys.exit(main())
