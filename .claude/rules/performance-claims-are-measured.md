---
paths:
  - "src/**"
  - "plugins/**"
  - "docs/developer-guide.md"
---

# Rule: a performance claim is measured, on a release build, or it is not made

This project has lost more time to plausible performance mechanisms than to hard ones. A single
investigation promoted three different causes ahead of their evidence - a never-shut-down
`ExecutorService`, an `InputMethodManager.mServedView` leak, and a Reanimated warning storm - and
all three were wrong. Every one was disproved by a measurement that could have been run first, and
one of them had been sitting in the docs as the accepted cause for two weeks. The cost is not the
wrong fix; it is the weeks spent building on it.

## The rule

**Measure on a release build.** `npx expo run:android --variant release --no-bundler`. The dev
client is not a weaker signal, it is a misleading one: the same commit measures 24.73% janky
frames on dev against 0.11% on release, and 1003 MB PSS against 483 MB. Never accept, report, or
act on a performance number sourced from a dev client, including your own impressions of one.

**Say which of these a statement is**, and never let the third wear the clothes of the first:

- **Measured** - a number, with the build, the device, the procedure and the sample size.
- **Read out of the source** - a code path anyone can check by opening the file.
- **Inferred** - a mechanism that fits. Label it. It is a hypothesis until a measurement kills or
  confirms it, and the ones that feel most obviously right are exactly the ones that have been
  wrong here.

**A number needs a control taken the same way.** Same install, same content, same process age,
same navigation. An A/B whose two arms differ in anything else measures that instead. A setting
that needs a restart (reduced motion, an `EXPO_PUBLIC_*` flag) means force-stopping and relaunching
BOTH arms, not just the one that needed it.

**Sample long enough to quote a range.** This app streams continuously under the demo peer, so its
load swings. The same condition read 22-46% and 65-86% from short samples and 48-51% from 20
samples over 40s. Report a median with its range; a wide range means the number is not ready.

**Two `dumpsys meminfo` samples, and trust the second.** Retention is what survives collection.
Single samples read 676, 690 and 694 views on a run whose settled value was 464.

**Bisect from one build, not one build per hypothesis.** A release build embeds its JS bundle, so
rebuilding per variant costs an APK each AND compares different installs against different
content. Extend `src/devsupport/retentionProbe.ts`, which puts variants behind a Settings switch.

**When a claim turns out to be wrong, retract it where it was made.** `docs/developer-guide.md`
carries its corrections inline with the reasoning that failed, not as a quiet edit. A wrong cause
that is merely deleted gets rediscovered.

## Enforcement (self-maintaining)

- **Skill (live now):** `/profile` carries the procedure, the four tools and which question each
  answers, and the `simpleperf` path that needs `plugins/withAndroidProfileable.ts`.
- **Review (live now):** `/code-review` and the `expo-rn-reviewer` agent flag a performance claim
  in a comment, commit message or doc that names no measurement, and a motion or list change that
  cites no before/after.
- **Mechanical (not planned):** whether a number came from a release build is not checkable from
  the diff. This one is review-and-discipline by construction, which is why the rule is explicit
  about labelling measured / read / inferred.

## Scope

Performance claims in authored code comments, commit messages, and `docs/`. Complements
`.claude/rules/motion-conventions.md`, which owns the motion-specific bar (the frequency gate, the
`useAnimatedProps` ban, an animation that never stops).
