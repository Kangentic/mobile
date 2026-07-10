---
paths:
  - "src/screens/**"
  - "src/components/**"
---
# Rule: screen and component UI conventions

The app has shared primitives, a font floor, and list-performance requirements that keep the UI
consistent, readable, and testable across a wide range of phone sizes. New UI reintroduces
one-off components, tiny fonts, and slow lists unless these are stated.

## The rule

- **Shared primitives:** build screens from `src/components/` design-system primitives. No
  one-off buttons, dialogs, or badges duplicating an existing shared component.
- **Minimum font size:** default body text is 14px (`text-sm` equivalent). The floor is 12px
  (`text-[11px]` scale note: the desktop convention's numeric floor, kept identical here),
  reserved for badges and dense labels. Never below 11px without explicit approval.
- **Touch targets:** interactive elements are at least 44x44pt.
- **Lists:** use FlashList for any feed, transcript, or board list. Never `FlatList` or a
  `.map()` inside a `ScrollView` for a list that can grow.
- **Test selectors:** every interactive element gets a stable `testID` (Maestro's selector
  mechanism).
- **Color:** use semantic color tokens from the design system. No hardcoded hex values in
  screens or components.
- **No hover-only affordances.** This is a touch platform; nothing may depend on a hover state
  to be discoverable or usable.

## Enforcement (self-maintaining)

- **Review (live now):** `/code-review` and the `expo-rn-reviewer` agent flag these on screen and
  component changes.
- **Test (planned, App Phase 1):** a scan for sub-floor font sizes and raw `FlatList` usage under
  `src/screens/` and `src/components/`.

## Scope

`src/screens/**` and `src/components/**`.
