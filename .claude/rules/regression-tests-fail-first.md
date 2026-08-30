---
paths:
  - "tests/**"
---

# Rule: a regression test is run against the unfixed code first

A test written alongside its fix passes for two reasons that look identical in CI: because the fix
works, or because the test never exercised the bug. The second kind is worse than no test - it is
a green check standing guard over nothing, and it is only ever discovered when the bug comes back.
This has happened here repeatedly, including twice in one session where a test passed against the
very bug it was written for.

## The rule

**Before trusting a regression test, watch it fail.** Either write it before the fix, or - the
usual case, since the fix is normally already in hand - mutate the source back to the broken
behaviour, run the test, see it red, then restore. A one-line mutation and two test runs.

The assertion that matters is the one that fails for the RIGHT reason. Read the failure output:
"expected 'reading-view' to be 'loading'" is the old bug reproducing; a crash, a missing testID,
or "received undefined" usually means the test never reached the behaviour at all.

**Prefer an assertion that cannot pass by accident.** Several bugs here are invisible in rendered
output, so the test has to assert the mechanism:

- The spin not running renders a correct-looking static arc, so assert the timing call, not the
  drawn frame.
- A `PressScale` reintroduced into a list row renders identically, so assert that
  `useAnimatedStyle` was never called.
- A `FlashList` handed a fresh `data` array every render looks perfect, so assert object identity
  across a re-render.
- Retention and CPU cannot be asserted at any JS tier at all. Do not fake it with a proxy - say so,
  and measure on device (`/profile`).

## Enforcement (self-maintaining)

- **Review (live now):** `/code-review` and the `test-builder` agent ask, for any test added
  beside a fix, whether it was seen failing and by what mutation. A test whose assertion would
  still hold with the fix reverted is a finding.
- **Mechanical (not planned):** no runner can tell a test that guards a bug from one that merely
  passes. Mutation testing would, and is disproportionate for this repo's size; the discipline is
  the control.

## Scope

Regression tests in `tests/unit/**` and `tests/components/**`, and Maestro flows under `.maestro/`
that encode a specific past failure. Does not govern tests for new behaviour that never had a bug,
where there is nothing to reproduce.
