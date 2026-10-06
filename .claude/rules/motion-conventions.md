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
- **A one-shot tween's resting value needs a JS-timer unmount, not a final frame.** The same
  last-write-wins property holds without any rebind: if the frames never arrive, the native view
  keeps its first write. On 2026-10-05 an iOS card on the Agents feed held the section pulse's
  first write (alpha 0.16, measured from the screenshot) until the app was force-killed. Why the
  frames were lost is inferred, not measured. So a transient overlay mounts for its window only,
  and a JS `setTimeout` unmounts it (`SectionLandingPulse`), because a React unmount needs no
  Reanimated frame. Never drive that unmount from the tween's completion callback through
  `runOnJS`: the callback runs on the frame that went missing. Three sites still carry this class
  and a JS timer cannot fix them, all READ from source and never observed stuck. `PressScale`'s
  press-out tween back to 1 (the view stays mounted, so a lost frame leaves a card at
  `pressedScale`). `SegmentedSwitcher`'s indicator (it self-heals on the next switch). And every
  `exiting=` preset (`ConnectionBanner`, `SessionSwapVeil`): Reanimated removes an exiting view
  only in the animation's finished callback on the UI runtime
  (`react-native-reanimated/src/layoutReanimation/animationsManager.native.ts`, the
  `shouldRemoveView` / `EXITING` branch, unchanged in 4.7.1 even though 4.7.0 made the new
  layout-animations engine the default), so a lost frame leaves the banner or veil on screen. If one of those is ever reported stuck
  after a resume, start here, and ask whether the spinners still turned: a dead frame loop
  freezes all of them at once.
- Never `setState` from a gesture or scroll handler. Use a shared value plus `useAnimatedStyle`.
- Never read or write a shared value during render. It fires mid-reconciliation, and a re-render
  you did not cause replays the write. Touch shared values only in worklets, handlers and effects.
- Prefer `.get()` and `.set()` over direct `.value` access. On Reanimated 4 (this project pins
  4.7.1, held past the SDK 57 mapping via `expo.install.exclude`) they are the documented
  compiler-safe form; direct `.value` is the shape the React
  Compiler cannot see through. The two places that predated this (`PressScale.tsx` and the Agents
  feed's section pulse, now `src/screens/home/SectionLandingPulse.tsx`) have both been converted.
  Convert any other `.value` you find when you touch the file rather than in a sweep, the same way
  `typescript-style.md` handles existing `any` casts.
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

**An animation that never stops keeps the whole app DRAWING at full frame rate.** Check what an
idle screen costs, not just what it looks like: the idle release build rendered 6131 frames in 51
seconds (continuous 120 Hz) because per-row spinners never end. That is a battery and thermal cost
no jank metric reports - `dumpsys gfxinfo` will call it perfectly smooth. The one sanctioned
exception is the session screen's wait cursor once the swap veil has outlived the quiet deadline
(`src/screens/task/SessionSwapVeil.tsx`, `BlinkingBlock`): a decision taken on 2026-09-18 to mirror
the desktop's own launch overlay, allowed ONLY because it is a two-state toggle on a JS interval
that draws two frames a second. It was first built as a Reanimated breath on the same cell-sized
view, on the argument that a frame's damage was one cell rather than a full screen. Measured on the
release build (emulator, every arm in one process, 2026-09-18), that breath drew 57 frames a second
at 24-28% of a core, the same as the full-screen scrim breath had, while the veil held static drew
0 frames at 1.5-4%. **A frame costs a frame however small the view that changed: there is no cheap
tween.** An earlier revision of this paragraph quoted the pulse at 11% against 5% static; those were
single samples over windows that were mostly static, and they are retracted. The blink is still
gated by the route's `ScreenMotionProvider` (a pushed route stops it), by OS reduced motion, and by
the OS itself once the app is backgrounded (measured: 4-8% and zero frames with the veil up). The
blink as shipped measured 1.6 frames a second at 10-12%, against a live idle terminal at 11-12.5%
in the same process. Anything else that loops must still stop on its own, and "on its own" has to
include the case where what it is waiting for never comes: the loading skeleton's pulse is bounded
by `skeletonPulse.holdAfterMs` (10 s, then the static branch) because a board stranded on its
skeleton by a lost subscribe was measured drawing 60 frames a second for the ninety seconds the
stall lasted, and nothing about a stall stops a tween.

**But do not read that as "Reanimated is idle when nothing animates" - at least, not on the
version this was measured on.** On **4.5.1**, `scheduledMapperRun` in
`react-native-reanimated/src/mappers.ts` re-armed itself EVERY FRAME for the life of the process on
native - the comment said so outright ("We always run mappers on native") - starting at init, not
when an animation began. `useAnimatedStyle` registers one mapper per mounted component
(`useAnimatedStyle.ts` -> `startMapper`); `mapperRun()` skips clean mappers, but calls
`updateMappersOrder()`, a recursive topological sort over ALL of them, whenever the mapper count
changes - which FlashList recycling does constantly.

So on 4.5.1 the frame loop could not be "stopped" - and, corrected by measurement (2026-08-30): the
useful question was **how many mappers are REGISTERED**, not only which are dirty. An in-process A/B
on a release build (the `extra-mappers` probe variant) added 64 clean, never-animating mappers to
the Agents list and idle CPU went from ~41% to ~70%, back to ~39% when removed - **~0.47 CPU points
per registered mapper, dirty or not**. An earlier revision of this paragraph claimed clean mappers
were skipped for free; that was read out of `mapperRun()`'s early-continue and did not survive the
experiment.

**4.7.1 removed that loop, and a registered CLEAN mapper is now free: measured (task #102,
2026-10-06).** A diff of `mappers.ts` 4.5.1 -> 4.7.1 deletes the self-re-arming
`schedulingFunction(scheduledMapperRun)` and its "We always run mappers on native" comment; native
now schedules a run only from `maybeRequestUpdates()`, when a mapper's input shared value changes,
the same on-demand path web always used. Read from source, that was a hypothesis, so it was then
measured the same way the 4.5.1 cost was: the `extra-mappers` arm, in ONE process on a 4.7.1
release build (the demo-paired `kangentic_profile` AVD, cold-booted), five phases off / extra /
off / extra / off with two 40-second windows each. The probe logged **64 mounted mapper units in
both extra phases and 0 in every off phase**, and idle CPU read 21-24% with them against 23-30%
without, frames flat at ~57 a second throughout. On 4.5.1 the same 64 cost ~29 points. (The
first attempt that day was void: the probe read the variant without subscribing, so only one
memoized row ever mounted its mappers. It now subscribes and logs `mapper-load mounted=N` on the
connection trace; check that count before reading any CPU number from it.) Practical consequences:

- **Register an animated hook only on the branch that animates - still.** The reason has
  narrowed, not gone. On 4.7.1 a registered mapper whose inputs never change costs nothing
  measurable, so an idle row's dead mapper is no longer a CPU cost. But a mapper whose input DOES
  change runs every frame it changes, and a transform written by a mapper outlives a recycle
  (the tilted-envelope bug above), so the hook still belongs in a child mounted only while
  animating (`AgentStatusIcon`'s `SpinningMark`/`MarchingMark` are the pattern, and its
  "registered mappers" test block is the mechanism assertion to copy).
- **What costs CPU on 4.7.1 is frames, not registrations.** An animation that is running is the
  cost (the paragraph above on "an animation that never stops"), so count what is MOVING on an
  idle screen, not how many animated hooks are mounted.
- The two component-swap attempts stand as cautions against ARGUED swaps: the activity-ring focus
  gate is worth ~9 points (measured, on 4.5.1, and a focus gate stops frames, so it still
  applies); `Card`'s `PressScale`-to-`Pressable` swap moved nothing resolvable and was reverted.

Do not re-derive any of this by argument; see `performance-claims-are-measured.md` and `/profile`.

## Enforcement (self-maintaining)

- **Review (live now):** `expo-rn-reviewer` covers the FlashList and list-performance conventions
  during `/code-review`, and treats `useAnimatedProps` into a third-party component as a HIGH
  finding; `/design-pass` cites this rule as the motion bar for a screen pass.
- **Test (live now):** `tests/components/SectionLandingPulse.test.tsx` pins the one-shot-tween
  bullet for the section pulse: no overlay and no mapper outside the window, and an unmount on the
  JS timer while the overlay still holds its first write (Jest's Reanimated mock never advances a
  tween, which is exactly the stuck state). A NEW one-shot overlay elsewhere has no mechanical
  check; review is the backstop.
- **Lint (live now):** `eslint.config.mjs` bans a `useAnimatedProps(` call outside an explicit
  allowlist (`no-restricted-syntax`; the sole entry is `src/components/AgentStatusIcon.tsx`,
  whose inert march genuinely moves a dash). Widening the allowlist is the mechanical prompt to
  argue the cost in review. `Lint (ESLint)` is a required check on `main`, so this is CI-gated.
  Two selectors, not one: `CallExpression[callee.name=...]` matches only an unqualified call, so
  a namespace import (`import * as Reanimated` then `Reanimated.useAnimatedProps(...)`, already
  the house style in this repo's test files) needs the `callee.property.name` selector as well.
  `tests/unit/eslintConfig.test.ts` pins both forms, and pins the ordering hazard below.
- **Flat config replaces rule options, it does not merge them.** Two entries setting the same
  rule leave the LAST matching one as the only live configuration for a file. That is why the
  `expo-haptics` ban is restated inside the crypto/push directory entry in `eslint.config.mjs`,
  and why the per-file allowlists re-state the selector that still applies rather than adding to
  a base. Getting this wrong is silent: no error, no warning, and a green CI on a ban that stopped
  matching. It has already happened once here (the haptics entry, ordered after the
  `crash-reporting-scope.md` directory ban, disabled it for every file in those directories).
- **Type system (live now):** the `HapticCue` union makes an unlisted cue a compile error
  (`npm run typecheck`, gated in `.github/workflows/ci.yml`).
- **Lint (live now):** `eslint.config.mjs` also bans importing `expo-haptics` outside
  `src/lib/haptics.ts` (`no-restricted-imports`) and a raw `Easing.bezier(` call outside
  `src/components/motion/` (`no-restricted-syntax`). `presets.ts` exports `bezierEasing` as the
  one place the four-argument spread is spelled; the two inline copies that used to exist
  (`SegmentedSwitcher.tsx`, `Skeleton.tsx`) were converged onto it when the lint landed.
- **Test (planned):** a scan for `entering=` / `exiting=` inside a `renderItem` body would catch
  the one failure here that is silent at runtime and invisible in review.

## Scope

Authored motion and haptics in `src/components/**` and `src/screens/**`. Does not govern
`src/brand/` generated motion data (the Overseer frame timings are generated output from the
branding manifest and must not be hand-tuned), or the terminal WebView, which paints its own
frames.
