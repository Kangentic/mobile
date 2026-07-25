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
- **Visible tap targets:** every tappable control shows a bounded surface - a raised fill, a
  hairline outline, or a tinted segment - so where to tap is visible before touching. No
  naked-glyph buttons; `IconButton` uses its `raised` variant unless a containing group
  (a toolbar pill, a segmented control) already frames the control.
- **Lists:** use FlashList for any feed, transcript, or board list. Never `FlatList` or a
  `.map()` inside a `ScrollView` for a list that can grow.
- **Every scrollable that holds a tappable control, on a screen that can have a keyboard up,
  sets `keyboardShouldPersistTaps="handled"`.** The default is `"never"`, which spends the
  first tap dismissing the keyboard, so the control needs two taps and reads as an unresponsive
  app. **It is NOT inherited**: a nested `ScrollView` inside one that sets it still defaults to
  `"never"`, which is how the create-task column chips shipped needing two taps while the
  `Sheet` around them was configured correctly. Applies to `FlashList` as much as `ScrollView`.
  Judge by whether a `TextInput` can be focused on that screen, remembering that the session
  screen keeps all three panes mounted, so the composer's keyboard outlives a lens switch.
- **Test selectors:** every interactive element gets a stable `testID` (Maestro's selector
  mechanism).
- **Color:** use semantic color tokens from the design system. No hardcoded hex values in
  screens or components.
- **No hover-only affordances.** This is a touch platform; nothing may depend on a hover state
  to be discoverable or usable.

## Enforcement (self-maintaining)

- **Review (live now):** `/code-review` and the `expo-rn-reviewer` agent flag these on screen and
  component changes.
- **Test (planned):** a scan for sub-floor font sizes and raw `FlatList` usage under
  `src/screens/` and `src/components/`, plus a scan for a `ScrollView`/`FlashList` that renders
  a `Pressable` without `keyboardShouldPersistTaps`. That last one needs an allowlist for the
  genuinely read-only scrollables (`MonoBlock`, `InlineDiff`, the diff viewers), which is why it
  is a scan rather than a lint rule.

## Scope

`src/screens/**` and `src/components/**`.
