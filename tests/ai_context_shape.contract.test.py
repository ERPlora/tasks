#!/usr/bin/env python3
"""The card this module hands the assistant has the shape the contract accepts (#39).

THE SYMPTOM. `ai_context` is the block a module writes so the assistant knows what the module is
about. The contract declares it an OBJECT — `schemas/module.schema.json` of the module-toolkit says
`{"type": "object"}` — and this module wrote a plain string. Nothing breaks today: the runtime
parks the block as `Option<serde_json::Value>` (`crates/runtime/src/manifest.rs`) and never walks
it, so a string deserialises without a word. What it costs is a warning on EVERY pull request
(module-toolkit#247), which is the worst possible outcome: the person reading it cannot tell a real
defect from noise, so they learn to skip the whole list. The day something reads the card with a
fixed shape, this module is the one left out, silently.

WHY A GATE AND NOT JUST THE FIX. The validator only says `object` — it is permissive on purpose
while the RAG design is parked, so `{"a": 1}` would silence the warning and leave the card just as
unusable. Turning the string into an object is the easy half; keeping it a card that says what
this module does is the half that rots. This file is the second half. It is the same gate
reservations#59 set up first, so the two cards answer to the same rules.

THE FOUR RULES, AND WHY EACH ONE

| The card must | Because |
|---|---|
| be an OBJECT, never a string | it is the contract the hub applies; a string is the defect this file was born from |
| carry a non-empty `summary` | the convention the schema names is `{ summary, keywords }`; an object without a summary is the same silence with a different type |
| carry non-empty, unique `keywords` | the keywords are the half a reader can search; an empty list is a card that answers nothing |
| name no version number | a version inside prose cannot be kept up to date, so it lies from the next release on — and a lie about the version is worse than no version |

And one rule about the keywords themselves: every keyword has to appear IN the summary. A keyword
the card's own prose does not back is a keyword nobody can act on, and it is how a list drifts into
decoration — `["tasks", "erp", "spain"]` reads fine and says nothing. Backing them to the summary
is what makes the two halves one card instead of two fields.

WHAT THIS DOES NOT COVER. Not whether the summary is GOOD prose — no test can hold that — and not
the other modules: reservations was the first card fixed this way (reservations#59), and every
other module answers in its own repo. This gate answers for this module only. The version rule is
prophylactic here: this module's string never carried a version, and the rule is what keeps one
from creeping into the card the day someone «completes» the summary.

THE CHECK IS CHECKED. Every rule runs against a handful of cards that are wrong on purpose before
it is trusted with the real one: a check that reports «nothing wrong» while knowing nothing is the
failure mode this repo has hit before, and the only defence is to feed it the positive and watch it
catch it (see `SELF_CHECK`).

Usage: tests/ai_context_shape.contract.test.py   (exit 0 = green)
  No database, no Docker: it reads `module.json`.
"""

import json
import pathlib
import re
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))

#: The two keys the convention names. Extra keys are ALLOWED on purpose: the schema is permissive
#: while the RAG design is parked, and closing that door here would make this module the one that
#: fails the day the design lands and adds a third field.
REQUIRED_KEYS = ("summary", "keywords")

#: A version number, with or without the `v`. Matched anywhere in the card's text — the reservations
#: card hid it inside a parenthesis, `(id: reservations, v3.0.3)`, which is exactly where nobody
#: looks when they bump the release.
VERSION_RE = re.compile(r"\bv?\d+\.\d+\.\d+\b")


def check(card: object) -> list[str]:
    """Everything wrong with `card`, in the words the failure prints. Empty list = the card is fine."""
    problems: list[str] = []

    if not isinstance(card, dict):
        kind = type(card).__name__
        return [
            f"`ai_context` is a `{kind}`, and the contract declares it an object. The hub applies "
            "that same contract: a card it cannot read is a module the assistant cannot describe, "
            "and nothing says so out loud (module-toolkit#247)"
        ]

    for key in REQUIRED_KEYS:
        if key not in card:
            problems.append(
                f"`ai_context` has no `{key}`. The shape the schema names is "
                "`{ summary, keywords }`, and an object missing half of it silences the validator "
                "without giving anyone anything to read"
            )

    summary = card.get("summary")
    if "summary" in card:
        if not isinstance(summary, str) or not summary.strip():
            problems.append(
                f"`ai_context.summary` is `{summary!r}`: it has to be a non-empty string — it is "
                "the sentence that says what this module does"
            )

    keywords = card.get("keywords")
    if "keywords" in card:
        if not isinstance(keywords, list) or not keywords:
            problems.append(
                f"`ai_context.keywords` is `{keywords!r}`: it has to be a non-empty list — the "
                "keywords are the half a reader can search for"
            )
        else:
            for kw in keywords:
                if not isinstance(kw, str) or not kw.strip():
                    problems.append(
                        f"`ai_context.keywords` carries `{kw!r}`, which is not a keyword: every "
                        "entry has to be a non-empty string"
                    )
            lowered = [kw.strip().lower() for kw in keywords if isinstance(kw, str)]
            for kw in sorted({k for k in lowered if lowered.count(k) > 1}):
                problems.append(
                    f"`ai_context.keywords` repeats `{kw}`: a keyword listed twice is not searched "
                    "twice, it is only a list nobody curated"
                )

    # The keywords have to be backed by the prose. Only meaningful once both halves are readable.
    if isinstance(summary, str) and isinstance(keywords, list):
        haystack = summary.lower()
        for kw in keywords:
            if (
                isinstance(kw, str)
                and kw.strip()
                and kw.strip().lower() not in haystack
            ):
                problems.append(
                    f"`ai_context.keywords` offers `{kw}`, which the summary never says. A keyword "
                    "the card's own prose does not back is decoration: it sends a reader to a "
                    "module that will not answer for it"
                )

    # No version number anywhere in the card — a rule copied from reservations#59, where the string
    # DID lie about the version. Prophylactic here, and it stays prophylactic.
    for key in sorted(card):
        for found in VERSION_RE.findall(json.dumps(card[key], ensure_ascii=False)):
            problems.append(
                f"`ai_context.{key}` names the version `{found}`. A version written into prose is "
                "never bumped with the release, so from the next one on the card states something "
                "false — the reservations card shipped `v3.0.3` inside its summary while releasing "
                "`v3.0.29` (reservations#57), which is the lie this rule exists to prevent"
            )

    return problems


#: Cards that are wrong on purpose, and the fragment the rule that catches them has to print. Each
#: one is the shape of a real relapse: the string this gate replaced, the empty object that silences
#: the validator, the emptied list, the keyword nobody backed, the version creeping back in.
SELF_CHECK: tuple[tuple[str, object, str], ...] = (
    (
        "the string this gate replaced",
        "Module: Tasks (id: tasks).",
        "declares it an object",
    ),
    ("an object with nothing in it", {}, "has no `summary`"),
    (
        "a summary that says nothing",
        {"summary": "  ", "keywords": ["tasks"]},
        "non-empty string",
    ),
    ("keywords emptied", {"summary": "Tasks.", "keywords": []}, "non-empty list"),
    (
        "a keyword repeated",
        {"summary": "Tasks.", "keywords": ["tasks", "Tasks"]},
        "repeats `tasks`",
    ),
    (
        "a keyword the prose never says",
        {"summary": "Tasks.", "keywords": ["invoicing"]},
        "which the summary never says",
    ),
    (
        "the version creeping back in",
        {"summary": "Tasks v1.0.31.", "keywords": ["tasks"]},
        "names the version",
    ),
)


def main() -> int:
    # The check is checked FIRST: a broken checker blesses the manifest instead of reading it.
    blind: list[str] = []
    for name, card, expected in SELF_CHECK:
        printed = " | ".join(check(card))
        if expected not in printed:
            blind.append(
                f"the rule for «{name}» did not fire: expected a message containing "
                f"{expected!r}, got {printed or '(nothing at all)'}"
            )
    if blind:
        print(f"FAIL ({len(blind)}): this gate cannot see the defect it exists for:")
        for b in blind:
            print(f"  - {b}")
        return 1

    if "ai_context" not in MANIFEST:
        print(
            "FAIL: `module.json` declares no `ai_context`. This module HAS a card and the "
            "assistant reads it; dropping it is not how the warning of #39 gets silenced"
        )
        return 1

    problems = check(MANIFEST["ai_context"])
    if problems:
        print(f"FAIL ({len(problems)}):")
        for p in problems:
            print(f"  - {p}")
        return 1

    card = MANIFEST["ai_context"]
    print(
        f"OK: `ai_context` is a card the contract accepts — {len(card['summary'].split())} words of "
        f"summary, {len(card['keywords'])} keyword(s) all backed by it, no version number "
        f"({', '.join(card['keywords'])})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
