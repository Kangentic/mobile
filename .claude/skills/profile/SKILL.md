---
description: Measure and profile Android runtime performance on a release build - idle CPU, frame timing, view retention, and a simpleperf sample that names the hot code. Use when the user reports lag, jank, battery drain or a leak, or asks to audit performance.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash, PowerShell
argument-hint: [what to measure, e.g. "idle CPU on the Agents list" or "retention on the session screen"]
---

# Profile

Android performance measurement for this app. Every number here is taken on a **release** build
on a real device, because the dev client is not a weaker signal, it is a misleading one: the same
commit measures 24.73% janky frames on dev and 0.11% on release, and 1003 MB PSS against 483 MB.

The full worked history lives in the REACT-NATIVE-5 section of
[docs/developer-guide.md](../../../docs/developer-guide.md). This skill is the procedure.

## Build

```sh
npx expo run:android --variant release --no-bundler
```

Installs as an upgrade, so a pairing survives. Add the flags below when the run needs them.

**A plugin change does NOT take effect through `expo run:android` alone.** It skips prebuild when
`android/` already looks current, so the plugin never runs and the build silently lacks it. Force
it, then build:

```sh
EXPO_PUBLIC_KANGENTIC_PROFILEABLE=1 npx expo prebuild --platform android
EXPO_PUBLIC_KANGENTIC_PROFILEABLE=1 npx expo run:android --variant release --no-bundler
```

Verify rather than assume: `grep profileable android/app/src/main/AndroidManifest.xml`. A clean
prebuild triggers a full native rebuild across all ABIs (~10 min), so budget for it.

## The four questions, and the tool for each

Do not mix them up. Each answers something the others cannot.

| Question | Command |
|---|---|
| Is it smooth? | `adb shell dumpsys gfxinfo <pkg> reset`, exercise, read back |
| Is it drawing at all? | `Total frames rendered` from the same dump over a known window |
| What does it cost? | `adb shell 'top -b -n 20 -d 2 -q -o CMD,%CPU -p $(pidof <pkg>)'` |
| Which thread? | same with `-H -o TID,CMD,%CPU` |
| What retains memory? | `adb shell dumpsys meminfo <pkg>`, Objects block |
| **What code is hot?** | `simpleperf`, below |

**Frames and CPU are independent, and the pair is diagnostic - so read them TOGETHER, always.**
A screen can burn half a core while rendering **zero** frames - that is non-drawing main-thread
work (animation worklets, mount items), and it means no jank metric will ever show it. `dumpsys
gfxinfo` will call such an app perfectly smooth. Conversely ~84fps sustained on a screen nobody
is touching means something invalidates the tree every frame. This is not hypothetical: the
Agents-list residual sat unattributed for weeks of CPU-only sampling, and the first run that
reset gfxinfo before each `top` sample settled it in one afternoon (23% CPU at literally 0
frames = non-drawing work, compositing exonerated). Reset gfxinfo at the start of every CPU
sample window and read `Total frames rendered` at its end.

**Idle CPU scales with REGISTERED Reanimated mappers, dirty or not (~0.47 points each).**
Measured with the probe's `extra-mappers` variant (`src/devsupport/MapperLoad.tsx`): +64 clean,
never-animating mappers took the idle Agents list 41% -> 70%, back to 39% when toggled off in
the same process. So when hunting idle CPU, count mounted `useAnimatedStyle`/`useAnimatedProps`
call sites (hooks above an early return register on EVERY branch), and use that variant to test
whether a screen's number tracks mapper count before blaming anything else.

**Percentages from `simpleperf report` renormalise after any win - compare cycles/second, not
shares.** After the sync-ui-props flag halved total cycles, `libhwui.so` "rose" from 16.5% to
25.5% while falling ~30% in absolute cycles; the share table read as "hwui is the new
bottleneck" and sent the investigation toward compositing, wrongly. Divide `Event count` by the
recorded duration and compare THAT across runs.

## simpleperf: the only tool that names the code

`simpleperf record -p` on a normal release APK fails with
`failed to open perf event file for event_type cpu-cycles:u: Permission denied` - a non-rooted
device only exposes perf events for an app that opted in. `plugins/withAndroidProfileable.ts`
adds `<profileable android:shell="true"/>` behind `EXPO_PUBLIC_KANGENTIC_PROFILEABLE=1`.

```sh
adb shell simpleperf record -p $(adb shell pidof com.kangentic.mobile) \
  -g -f 1000 --duration 10 -o /data/local/tmp/perf.data
adb shell simpleperf report -i /data/local/tmp/perf.data --sort dso -n --percent-limit 1
adb shell simpleperf report -i /data/local/tmp/perf.data --sort symbol -n --percent-limit 1
```

**Read the `dso` (shared object) report first.** A release build is R8-minified and the native
libraries are stripped, so symbol names are often useless - but the library name is not.
`libreanimated.so 45%` or `libhermes.so 45%` names the subsystem in one line, which is usually
the whole answer.

## Measurement discipline, learned the hard way

**Take two `dumpsys meminfo` samples and trust the second.** One reading called a clean screen a
+220-view leak that the next reading, eight seconds later, showed fully reclaimed. On a run whose
true value was 464 views, single samples read 676, 690 and 694.

**Control the process state across an A/B.** A setting that needs a restart to apply (reduced
motion, any `EXPO_PUBLIC_*` flag) means one arm ran on a fresh process and the other on a warmed
one - and that difference alone moved a reading more than the thing under test. Force-stop and
relaunch **both** arms, navigate identically, and discard the first ~12s.

**Sample long and report a median with its range.** This app streams continuously in the demo, so
its load swings. Short samples produced 22-46% and 65-86% for the *same* condition; 20 samples
over 40s produced 48-51%. If the range is wide, the number is not ready to act on.

**Bisect from ONE build.** A release build embeds its JS bundle, so editing a component and
rebuilding costs an APK per hypothesis AND compares different installs against different session
content. `src/devsupport/retentionProbe.ts` puts variants behind a Settings switch
(`EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE=1`); extend it rather than editing components.

**A variant that renders NOTHING is the sharpest tool.** An `EnrichedMarkdownText` with
`markdown=""` leaked identically to a fully rendered one, which eliminated the parser, the spans,
the measurement cache and the render executor in a single reading.

**The arithmetic beats the build.** Linear growth per cycle means per-instance accumulation, which
rules out every single-slot mechanism (`InputMethodManager.mServedView`, a singleton's one field)
before compiling anything.

**Free zero-build A/Bs on this app.** Restore all three afterwards - it is the user's phone.

```sh
adb shell "settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0"
adb shell "settings put global window_animation_scale 1.0; settings put global transition_animation_scale 1.0; settings delete global animator_duration_scale"
```

Collapsing the Agents list's sections removes rows (and their animations) without a build, which
is how the activity rings were exonerated: zero rings on screen still measured 43%.

## Reporting

State what was measured, on what build, with what procedure - and separate what was measured
from what was inferred. Three plausible mechanisms were promoted ahead of their evidence during
the REACT-NATIVE-5 investigation and all three were wrong (the render executor, the
`InputMethodManager` served view, a Reanimated warning storm). Each was caught by a measurement
that could have been run first.
