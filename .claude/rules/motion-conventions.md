---
paths:
  - "src/components/**"
  - "src/screens/**"
---
# Rule: motion and haptics conventions

The app has a motion system (theme `MotionTokens`, the `useMotionPresets` builders, `PressScale`,
a closed `HapticCue` union) but no stated craft bar, so the constraints that matter live in a
docstring in `presets.ts` and are invisible to anyone adding an animation from a screen file. The
failures this prevents are the expensive kind: motion that runs fine in a dev build on a fast
phone and drops frames on a three-year-old Android, an `entering` animation on a FlashList item
root that replays on every recycle, and a `setState` in a gesture handler that re-renders React
once per frame.

## The rule

**Gate it before building it.** Match motion to how often the user sees it. Something seen 100+
times a day (tab switches, keyboard, scrolling, a settings toggle) gets the platform default or
nothing. Frequent actions (press feedback, row selection) get near-imperceptible motion only.
Sheets, modals and banners get a standard animation. Delight belongs on rare and first-run states.
Tab switches never slide: peers are not a hierarchy.

**Use the shared vocabulary, not raw values.**

- Entering and exiting animations come from `useMotionPresets()`. Add a preset rather than
  hand-rolling a builder at a call site.
- Durations and curves come from `theme.motion` (`durations.instant|fast|base|slow`,
  `easing.standard|decelerate|accelerate`). No literal millisecond or bezier values in screens or
  components.
- Entering elements use `decelerate` (ease-out). `accelerate` is for exits only, where the element
  is leaving the moment the user is watching. Never put an accelerating curve on an entrance.
- Pressed states use `PressScale` and `theme.motion.pressedScale`, not a per-component scale.
- Haptics go through `triggerHaptic(cue)` with a cue from the `HapticCue` union. Never call
  `expo-haptics` directly from a screen or component, and never add a cue without adding it to the
  union.

**Keep motion off the JS thread.**

- Animate `transform` and `opacity`. Animating `width`, `height`, `margin`, `padding`, `flex`,
  `top` or `left` re-runs layout every frame for that node and its siblings. The one exception is
  an absolutely positioned element with no children.
- **Animate a NATIVE VIEW's transform, never another library's props.** `useAnimatedProps` into a
  third-party component (react-native-svg's `matrix`, `strokeDashoffset`, `d`, `cx`; a chart
  library's geometry) re-runs that library's rendering on every frame. It is the single most
  expensive motion mistake available in this codebase, and it does not look expensive in review.
  Measured on a release build, Pixel 11 Pro, the Agents list idle with eight spinning marks:
  driving an SVG group's `matrix` through `useAnimatedProps` cost **~8 percentage points of CPU
  per icon** - ~106% total, more than a full core, with the GPU idle at 1 ms. Moving the same turn
  to a `transform: [{ rotate }]` on a wrapping `Animated.View` around a STATIC `<Svg>` took it to
  ~56% and dropped GPU memory from 92 MB to 52 MB. If a shape genuinely has to change (a dash
  marching, a path morphing), that is a deliberate cost to argue for, not a default.
- **A conditional mount is what makes a transform safe on a recycled row.** Render the animated
  wrapper ONLY on the branch that animates, so a rebind unmounts it. Reanimated writes straight to
  the native node, so React's prop diff never clears a transform on a node that survives the
  rebind: the row keeps whatever angle was last written. That is the tilted-envelope bug
  (e4e5524), and it is a property of the mount, not of the transform's shape.
- Never `setState` from a gesture or scroll handler. Use a shared value plus `useAnimatedStyle`.
- Never read or write a shared value during render. It fires mid-reconciliation, and a re-render
  you did not cause replays the write. Touch shared values only in worklets, handlers and effects.
- Prefer `.get()` and `.set()` over direct `.value` access. On Reanimated 4 (this project pins
  4.5.1) they are the documented compiler-safe form; direct `.value` is the shape the React
  Compiler cannot see through. Existing code predates this and still uses `.value` in
  `Skeleton.tsx`, `PressScale.tsx` and `TriageHomeScreen.tsx`. Convert those when you touch the
  file rather than in a sweep, the same way `typescript-style.md` handles existing `any` casts.
- Reach for a shared value only when the value is continuous or interruptible. A two-state toggle
  is a preset or a transition, not a worklet.

**Lists.** Never hand an `entering`, `exiting` or layout animation to a FlashList `renderItem`
root: recycling replays it on every bind. Animate the container, or use `itemLayoutAnimation`.

**Reduced motion ships with the animation**, never as a follow-up. Presets already carry
`ReduceMotion.System`. Anything hand-rolled sets it explicitly. Reduced motion means gentler, not
absent: keep opacity and color changes that explain a state change, drop translation, scale and
overshoot.

**A haptic is never the only feedback.** It fires on the same frame as its visual, once per user
action, never per frame and never on an entrance the user did not cause. Haptics are off
system-wide for many users and silent on much Android hardware, so the visual has to stand alone.

**Feel is judged on a release build on the slowest supported device.** A dev build's JS thread is
slow enough to hide the problems you are looking for, and fast enough elsewhere to hide the rest.
This is not a nuance, it is two orders of magnitude: the same commit measured **24.73% janky frames
on the dev client and 0.11% on release** (median frame 21 ms against 7 ms). A "feels laggy" report
gathered on a dev client is not evidence about the shipped app, and acting on one wastes the fix.
`npx expo run:android --variant release --no-bundler` builds and installs one in a few minutes; see
the REACT-NATIVE-5 section of [docs/developer-guide.md](../../docs/developer-guide.md) for the
measurement commands.

**An animation that never stops keeps the whole app at full frame rate.** Check what an idle screen
costs, not just what it looks like: the idle release build rendered 6131 frames in 51 seconds
(continuous 120 Hz) because per-row spinners never end. That is a battery and thermal cost that no
jank metric reports - `dumpsys gfxinfo` will call it perfectly smooth.

## Enforcement (self-maintaining)

- **Review (live now):** `expo-rn-reviewer` covers the FlashList and list-performance conventions
  during `/code-review`, and treats `useAnimatedProps` into a third-party component as a HIGH
  finding; `/design-pass` cites this rule as the motion bar for a screen pass.
- **Lint (planned, and the strongest upgrade available here):** a `no-restricted-syntax` rule
  banning `useAnimatedProps` outside an allowlist would make the expensive mistake mechanical
  rather than review-only. The codebase currently has ONE call site left
  (`AgentStatusIcon`'s inert march), so such a rule would land green today - which is exactly when
  a rule is cheap to add and never afterwards.
- **Type system (live now):** the `HapticCue` union makes an unlisted cue a compile error
  (`npm run typecheck`, gated in `.github/workflows/ci.yml`).
- **Lint (planned):** two `no-restricted-imports` / `no-restricted-syntax` rules are mechanizable
  today and are the strongest available upgrade here. One bans importing `expo-haptics` outside
  `src/lib/haptics.ts` (the boundary already holds, so it would land green and stay that way).
  The other bans a raw `Easing.bezier(` call outside `src/components/motion/`, which is the
  duplication that actually exists: `presets.ts` has a `bezierEasing` helper, and
  `SegmentedSwitcher.tsx` and `Skeleton.tsx` each inline the same four-argument spread instead of
  importing it. Both pass token values, so neither is a correctness bug today, but the third copy
  is where a literal creeps in.
- **Test (planned):** a scan for `entering=` / `exiting=` inside a `renderItem` body would catch
  the one failure here that is silent at runtime and invisible in review.

## Scope

Authored motion and haptics in `src/components/**` and `src/screens/**`. Does not govern
`src/brand/` generated motion data (the Overseer frame timings are generated output from the
branding manifest and must not be hand-tuned), or the terminal WebView, which paints its own
frames.
