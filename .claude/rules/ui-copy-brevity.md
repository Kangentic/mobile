---
paths:
  - src/screens/**
  - src/components/**
---

# Rule: UI copy is brief - context does the work

Verbose labels restate what the surrounding screen already says ("Unpair this desktop" on a
card titled "Your desktop") and long descriptions wrap into orphan lines on phone widths. The
screen's context carries the object; the label carries only the action or the new fact.

## The rule

- **Labels name the action, not the object, when the context names the object.** "Unpair",
  not "Unpair this desktop", on the desktop card; "Pair", not "Pair with your desktop", under
  an empty state already titled "No desktop paired". Where a button has to widen to read as a
  primary call to action, widen the button, not the words.
- **Descriptions are one line at default font on a small phone (~45 characters).** If a
  description needs two lines, cut words before wrapping; never let a single word orphan-wrap.
- **Only useful information.** No restating the obvious ("of any kind", "on this phone"), no
  parenthetical dev trivia in user-facing copy, no filler status lines duplicating what an
  icon or section header already communicates.
- **Confirmations state the consequence, briefly.** "Replaces the pairing on this phone" -
  one clause, no hedging.
- **Accessibility labels are EXEMPT** and should stay fully descriptive ("Stop the running
  agent (Ctrl+C)"): screen-reader users do not see the visual context.

## Enforcement (self-maintaining)

- **Review (live now):** `/design-pass` (its "Copy is UI" principle points here) and
  `/code-review` via the `expo-rn-reviewer` agent flag verbose labels and wrapping-prone
  descriptions on screen/component diffs.
- **Mechanical (not planned):** copy quality is not mechanizable; review-only is deliberate.

## Scope

User-visible strings in `src/screens/**` and `src/components/**`. Accessibility labels,
error messages carrying diagnostic detail, and recorded terminal/transcript content are
exempt.
