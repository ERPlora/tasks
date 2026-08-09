#!/usr/bin/env python3
"""Creating a task with NO project and NO parent must PARSE on Postgres (tasks#1).

Why this file exists: `commands/_insert_task.sql` guarded its own foreign keys with the sentinel
`(:project_id IS NULL OR EXISTS (...))`. Postgres fixes a parameter's type at its FIRST
appearance and `IS NULL` contributes none, so it answers
`could not determine data type of parameter` (42P08) **at prepare time** whenever the bind
arrives NULL — which is the default of `schemas/create_task.json` for both `project_id` and
`parent_task_id`. In other words: the ordinary "create a task" (no project, no parent) could not
run at all. Since ADR-0154 the module only ships a `postgres` dialect, so there is no engine
where it worked.

Why NULL and not any value: the runtime binds a JSON null as `DynNull`, which travels with OID 0
(`hub/crates/db/src/lib.rs`), i.e. "you infer it". With a real string the type comes in the Parse
message and the same SQL prepares fine — that is exactly why this only broke the empty path.
Same family that killed every list in Hub Cloud on 2026-07-05 (`crates/runtime/src/queries.rs`).

`erplora validate` only WARNS about it (`null-untyped`), and no module repo runs `validate` in CI
anyway (ERPlora/pm#107). So the gate is here, against a real Postgres.

What it does: builds a scratch database from THIS module's own migrations, lowers `:name` to `$n`
and rewrites the ERPlora SQL bridge functions exactly like the runtime does, and asks Postgres to
PREPARE the statement **with every bind left untyped** — the shape of the all-optional-absent
call. Zero mocks.

Usage: tests/insert_task.pg.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container by default (override: ERPLORA_TEST_PG_CONTAINER).
  Creates a scratch database and DROPS it at the end, pass or fail. If Docker or the container is
  missing the check is SKIPPED, never passed.
"""

import json
import os
import pathlib
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
CONTAINER = os.environ.get("ERPLORA_TEST_PG_CONTAINER", "erplora-test-pg-5433")

COMMAND = "tasks._insert_task"
SQL_FILE = "commands/_insert_task.sql"


def scan_args(sql, open_idx):
    """Balanced arguments of the `(` at `open_idx` → (list of raw args, index after the `)`)."""
    depth, start, i, in_string, args = 0, open_idx + 1, open_idx, False, []
    while i < len(sql):
        c = sql[i]
        if in_string:
            in_string = c != "'"
            i += 1
            continue
        if c == "'":
            in_string = True
            i += 1
            continue
        if c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                args.append(sql[start:i])
                return args, i + 1
        elif c == "," and depth == 1:
            args.append(sql[start:i])
            start = i + 1
        i += 1
    raise AssertionError("unbalanced parentheses")


def shim_erp_pad(sql):
    """`erp_pad(value, width)` → `lpad((value)::text, width, '0')`, like the runtime does.

    Only bridge function this module uses. Mirrors `render_bridge_fn` in `hub/crates/db/src/lib.rs`;
    if a new `erp_*` shows up in this file, add it here — an unrewritten one would look to Postgres
    like a missing function and this test would fail for the wrong reason.
    """
    out, i, in_string = [], 0, False
    while i < len(sql):
        c = sql[i]
        if in_string:
            out.append(c)
            in_string = c != "'"
            i += 1
            continue
        if c == "'":
            in_string = True
            out.append(c)
            i += 1
            continue
        previous_is_ident = i > 0 and (sql[i - 1].isalnum() or sql[i - 1] == "_")
        if not previous_is_ident and sql[i : i + 7].lower() == "erp_pad":
            j = i + 7
            while j < len(sql) and sql[j].isspace():
                j += 1
            if j < len(sql) and sql[j] == "(":
                args, after = scan_args(sql, j)
                assert len(args) == 2, f"erp_pad expects 2 arguments, got {len(args)}"
                value, width = shim_erp_pad(args[0].strip()), args[1].strip()
                out.append(f"lpad(({value})::text, {width}, '0')")
                i = after
                continue
        out.append(c)
        i += 1
    return "".join(out)


def translate(sql):
    """Lower `:name` to `$n` like the runtime does (`hub/crates/db/src/lib.rs::translate`).

    Index by order of FIRST appearance, a repeated name reuses its index, `::` is the Postgres
    cast (never a bind), and a `:name` inside a string literal or a comment stays verbatim — the
    runtime emits comments untouched and a bind that only lives in one would become a phantom `$n`.
    """
    sql = shim_erp_pad(sql)
    out, names, i, in_string = [], [], 0, False
    while i < len(sql):
        c = sql[i]
        if in_string:
            out.append(c)
            in_string = c != "'"
            i += 1
            continue
        if c == "'":
            in_string = True
            out.append(c)
            i += 1
            continue
        if sql[i : i + 2] == "--":
            j = sql.find("\n", i)
            j = len(sql) if j < 0 else j
            out.append(sql[i:j])
            i = j
            continue
        if sql[i : i + 2] == "/*":
            j = sql.find("*/", i + 2)
            j = len(sql) if j < 0 else j + 2
            out.append(sql[i:j])
            i = j
            continue
        if sql[i : i + 2] == "::":
            out.append("::")
            i += 2
            continue
        if c == ":":
            j = i + 1
            while j < len(sql) and (sql[j].isalnum() or sql[j] == "_"):
                j += 1
            name = sql[i + 1 : j]
            if name:
                if name not in names:
                    names.append(name)
                out.append(f"${names.index(name) + 1}")
                i = j
                continue
        out.append(c)
        i += 1
    return "".join(out), names


def docker_available():
    try:
        r = subprocess.run(
            ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def psql(db, sql):
    return subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-d",
            db,
            "-v",
            "ON_ERROR_STOP=1",
            "-q",
            "-X",
        ],
        input=sql,
        capture_output=True,
        text=True,
    )


def main():
    spec = MANIFEST["commands"][COMMAND]
    files = spec["sql"] if isinstance(spec["sql"], list) else [spec["sql"]]
    assert SQL_FILE in files, f"{COMMAND} no longer runs {SQL_FILE}: {files}"

    # The premise of the test: both refs are optional and default to null. If that ever changes,
    # the NULL path this guards would stop existing and the reader deserves to know.
    schema = json.loads((MODULE_DIR / "schemas" / "create_task.json").read_text())
    for ref in ("project_id", "parent_task_id"):
        assert schema["properties"][ref]["default"] is None, (
            f"{ref} no longer defaults to null"
        )

    if not docker_available():
        print(f"SKIPPED: no Postgres in container {CONTAINER} (nothing was verified)")
        return 0

    db = f"tasks_insert_task_{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True
    )
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            r = psql(db, (MODULE_DIR / rel).read_text())
            if r.returncode != 0:
                print(f"FAIL: migration {rel} does not apply\n{r.stderr}")
                return 1

        failed = 0
        for rel in files:
            sql, _names = translate((MODULE_DIR / rel).read_text())
            r = psql(db, f"PREPARE stmt AS {sql};\nDEALLOCATE stmt;\n")
            if r.returncode != 0:
                error = " ".join(
                    x for x in r.stderr.splitlines() if x.startswith("ERROR")
                )
                print(
                    f"FAIL: Postgres cannot prepare {rel} with untyped binds\n    {error}"
                )
                failed += 1
        if failed:
            return 1
        print(
            f"OK: Postgres prepares {COMMAND} with every bind untyped (project/parent absent)"
        )
        return 0
    finally:
        subprocess.run(
            ["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db]
        )


if __name__ == "__main__":
    sys.exit(main())
