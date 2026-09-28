#!/usr/bin/env python3
"""`tasks.projects.update` edits ONE live project of THIS hub, and refuses every other case
(ERPlora/tasks#43).

WHY IT EXISTS. A project, once created, could not be touched: no command renamed it, recoloured it
or took it out of use, so the project card had nothing to offer when tapped. The project sheet now
edits name, colour and «active» through this command.

WHAT THIS PINS, in the two halves a module repo can pin:

  1. the manifest declares the command with the MANAGE permission, a row gate (`expect_rows`) with
     a namespaced code translated in BOTH catalogues, and the event it emits is listed in
     `events.emits`;
  2. against a real Postgres, the SQL changes exactly the target row (name, colour, active, audit
     columns) and leaves its code, its siblings and another hub's project alone — and affects zero
     rows for an unknown id, another hub's project and a soft-deleted one, so the gate refuses them
     and no event is written.

Usage: tests/project_update_guard.pg.test.py   (exit 0 = green)
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

COMMAND = "tasks.projects.update"
EVENT = "tasks.project.updated"
NOT_FOUND = "tasks.project_not_found"

failures: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


def check_manifest() -> bool:
    spec = MANIFEST["commands"].get(COMMAND)
    if not spec:
        fail(f"module.json declares no `{COMMAND}`: a created project cannot be edited (tasks#43)")
        return False

    if spec.get("permission") != "tasks.manage_task":
        fail(f"`{COMMAND}` must need `tasks.manage_task`, got {spec.get('permission')!r}")

    if EVENT not in (spec.get("emit") or []):
        fail(f"`{COMMAND}` does not emit `{EVENT}`: an open Projects page elsewhere never refreshes")
    if EVENT not in (MANIFEST.get("events") or {}).get("emits", []):
        fail(f"`{EVENT}` is missing from events.emits")

    gate = spec.get("expect_rows") or {}
    if gate.get("op") != "min" or gate.get("n", 0) < 1 or gate.get("error") != NOT_FOUND:
        fail(f"`{COMMAND}` needs expect_rows min 1 → `{NOT_FOUND}`, got {gate!r}")
    if NOT_FOUND not in (MANIFEST.get("errors") or {}):
        fail(f"module.json → errors does not declare `{NOT_FOUND}` (ADR-0398)")
    for lang in ("en", "es"):
        catalog = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text())
        text = (catalog.get("errors") or {}).get(NOT_FOUND)
        if not isinstance(text, str) or not text.strip():
            fail(f"locales/{lang}.json has no `errors.{NOT_FOUND}` — the UI would show the raw code")

    schema = json.loads((MODULE_DIR / spec.get("schema", "")).read_text()) if spec.get("schema") else {}
    required = set(schema.get("required") or [])
    if not {"project_id", "name", "color", "is_active"} <= required:
        fail(f"schema of `{COMMAND}` must require project_id, name, color, is_active: {sorted(required)}")
    if "code" in (schema.get("properties") or {}):
        fail(f"`{COMMAND}` must not take `code`: the code is the project's key and stays fixed")
    return True


def row(db, project_id: str) -> str:
    return db.scalar(
        "SELECT code || '|' || name || '|' || color || '|' || is_active || '|' || "
        "coalesce(updated_by, '-') || '|' || coalesce(updated_at, '-') "
        f"FROM tasks_project WHERE id = '{project_id}'"
    )


def check_behaviour(db) -> None:
    pg.seed_project(db, "p-live", code="Q3", name="Audit", color="#111111")
    pg.seed_project(db, "p-sibling", code="Q4", name="Sibling", color="#222222")
    pg.seed_project(db, "p-other", code="Q3", name="Next door", color="#333333", hub=pg.OTHER_HUB)
    pg.seed_project(db, "p-gone", code="Q5", name="Gone", deleted=1)

    before_sibling = row(db, "p-sibling")
    before_other = row(db, "p-other")
    before_gone = row(db, "p-gone")
    if not before_sibling or not before_other:
        fail("fixture missing: seeded projects are not in the scratch database — check is vacuous")
        return

    try:
        affected = db.run_command(
            COMMAND, {"project_id": "p-live", "name": "Audit 2026", "color": "#00aa00", "is_active": 0}
        )
    except pg.CommandRejected as exc:
        fail(f"editing a REAL project was rejected as `{exc.code}` — the gate is too tight")
        return
    if affected != 1:
        fail(f"editing a real project affected {affected} rows, expected 1")
    expected = f"Q3|Audit 2026|#00aa00|0|{pg.USER}|{pg.NOW}"
    if row(db, "p-live") != expected:
        fail(f"edited project reads {row(db, 'p-live')!r}, expected {expected!r}")

    # Re-activating is the same command, and it must stay a success.
    try:
        db.run_command(COMMAND, {"project_id": "p-live", "name": "Audit 2026", "color": "", "is_active": 1})
    except pg.CommandRejected as exc:
        fail(f"re-activating a real project was rejected as `{exc.code}`")
    if not row(db, "p-live").startswith("Q3|Audit 2026||1|"):
        fail(f"re-activating did not store active=1 and the cleared colour: {row(db, 'p-live')!r}")

    if row(db, "p-sibling") != before_sibling:
        fail("editing one project changed its sibling in the same hub (WHERE id lost)")
    if row(db, "p-other") != before_other:
        fail("editing a project changed another hub's project (tenancy)")

    for label, project_id in (
        ("a project_id that does not exist", "ghost"),
        ("a project belonging to another hub", "p-other"),
        ("a soft-deleted project", "p-gone"),
    ):
        try:
            affected = db.run_command(
                COMMAND, {"project_id": project_id, "name": "Hijacked", "color": "#000000", "is_active": 1}
            )
        except pg.CommandRejected as exc:
            if exc.code != NOT_FOUND:
                fail(f"{label}: rejected with `{exc.code}`, expected `{NOT_FOUND}`")
            continue
        fail(f"{label}: edit reported success ({affected} rows) and the runtime would emit `{EVENT}`")

    if row(db, "p-other") != before_other:
        fail("an edit aimed at another hub's project changed it (tenancy)")
    if row(db, "p-gone") != before_gone:
        fail("an edit aimed at a soft-deleted project changed it")


def main() -> int:
    manifest_ok = check_manifest()

    if not pg.container_available():
        print(f"SKIPPED: no Postgres in container {pg.CONTAINER} (nothing was verified)")
        return 1

    if manifest_ok:
        db = pg.ScratchDb("tasks_project_update")
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
    print("OK: project edit only touches a live project of this hub, and is gated otherwise")
    return 0


if __name__ == "__main__":
    sys.exit(main())
