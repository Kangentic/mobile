# Rule: no em-dashes or double-dashes as punctuation

Em-dashes (U+2014) render as garbled characters on some Windows console code pages, and the
project develops on Windows without a Mac in the loop. Double-dashes (`--`) used as separators
look awkward in UI text and terminal output. Authored punctuation must use a single dash or be
restructured.

## The rule

Never use an em-dash (U+2014, the long dash), `&mdash;`, or `--` as a sentence or list
separator in anything you author: source code, comments, tests, docs, scripts, JSX, commit
messages, and user-facing chat.

- Use a single dash for inline separators, e.g. `**Bold** - description`.
- Or restructure the sentence with a period.

This forbids em-dashes you write. It does not forbid em-dashes that appear inside recorded
data (captured terminal scrollback, replay fixtures, assertions that mirror real agent
output), where the character is content, not punctuation you chose.

## Enforcement (self-maintaining)

- **Test (planned, App Phase 1):** `tests/unit/no-em-dashes.test.ts` will scan `src/` and
  `scripts/` and fail on any U+2014, once the vitest harness lands.
- **Review (live now):** the `expo-rn-reviewer` agent flags em-dashes anywhere during
  `/code-review`, including `tests/`, `docs/`, and markdown, which the future mechanical test
  will deliberately not scan.

Mechanical coverage of `tests/` and `docs/` is intentionally left to review: those trees
contain captured data, and widening the test would require distinguishing authored text from
recorded content, which a static scan cannot do.

## Scope

Punctuation you author, in any file type. Recorded or captured content is exempt.
