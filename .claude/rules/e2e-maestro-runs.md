---
paths:
  - ".maestro/**"
  - "scripts/stubDesktopPeer.mjs"
  - "scripts/dev.mjs"
---

# Rule: run Maestro through the CLI, one rig mode at a time

An E2E session that fights its own tooling reads as a broken product. Driving Maestro through
the MCP server while the dev rig is running starts a second device driver: the two collide and
the MCP server stops responding rather than erroring, hanging for minutes on calls as trivial as
`cheat_sheet`. The same work through `maestro test` returns in seconds. Separately, starting a
second rig mode silently kills the first one's bundler. Both failures look like flaky tests.

## The rule

- **Run flows with the Maestro CLI**, never the MCP `run` tool:
  `maestro --device <serial> test <flow-or-dir>`. The MCP server is for authoring only
  (`inspect_screen` against an otherwise idle device), and even then not while a suite is running.
- **One rig mode per session.** `dev:live` and `dev:stub` both own Metro on port 8081; starting
  one tears the other's bundler out from under the device. Pick the mode for the job.
- **Against a dev client, never `launchApp: clearState: true`.** Clearing state also wipes the
  saved Metro bundle URL, so the app comes up on the dev launcher and no JS loads. Clear state
  outside the flow and re-point the dev client at Metro before it starts
  (`dev.mjs`'s `pointDevClientAtMetro`).
- **Dismiss the dev client's first-run sheet before addressing anything of ours.** It is a
  separate window covering the whole screen: while it is up the app's view tree is absent from
  the hierarchy entirely, so no `testID` resolves however visible the screen looks. Its
  "Continue" only dismisses the explainer and opens the dev menu proper, which then needs
  closing.
- **Address our own UI by `testID`, never by label.** A flow that taps visible copy breaks the
  next time the copy changes, silently and at full timeout.
- **Exception: NATIVE chrome we do not render.** The bottom tab bar is expo-router `NativeTabs`,
  so its buttons are platform views with no `testID` of ours to set. `testID` reaches them only
  through `unstable_nativeProps`, which expo-router's own types warn "may change or be removed
  in minor versions" and "will override any other props set by Expo Router". Depending on that
  for E2E selectors trades one fragility for a worse one, so the flows select tabs by their
  LABEL (`text: "Board"`). This is the narrow carve-out: it applies where the platform owns the
  view, not to anything we render ourselves.
- **The rig may only kill a process it started itself.** Kill targets come from the
  `.devrig-processes/` registry (`scripts/rigProcessRegistry.mjs`) and are verified against the
  identity the OS reported for that pid at spawn time, because Windows recycles pids. Never
  derive a target from a command line, a process name, or who holds a port: the scan that did
  matched `--expose-gc ... start` via `expo(-cli)?.*start` and killed a running Kangentic desktop
  with every agent session under it. A process the rig did not start gets **reported**, not
  taken. `npm run dev:stop -- --dry-run` prints the targets and kills nothing.
- **A flow that calls itself self-contained must be.** The stub peer restores its canned board on
  every session establish, which is one flow; do not add state that outlives that boundary.
- **Never edit `src/` while a suite is running against Metro.** Fast Refresh pushes every save
  into the app mid-flow, so a half-finished edit becomes the build under test. It does not fail
  honestly: it presents as most flows failing on unrelated selectors, which reads as a product
  regression. Observed turning a 7/11 run into 8/11 failures. Either finish and commit before
  running, or run against an `e2e` build, which has no bundler attached to push anything.

## Diagnosing a failure

**Read the failure screenshot before forming a hypothesis.** Maestro writes them to
`~/.maestro/tests/<timestamp>/<flow>/screenshots/`, and every expensive E2E mistake in this
project came from reasoning about a selector instead of looking at the screen: a row whose
SECTION was collapsed, a delete row that was never armed, a chat lens that was rendering
correctly and had simply scrolled the asserted text off. The `e2e-flow-doctor` agent owns the
full diagnosis order (screenshot, then whether the request reached the stub, then crash, then
leftover state, then selector stability, and only then timing) and lands one of four verdicts:
fix the app, fix the flow, rewrite it, or delete it.

Three failure modes worth knowing without spawning anything:

- **Persisted state outlives `launchApp`**, which force-stops rather than clears. The Agents
  feed's section collapse is persisted, so one stray tap on a header hides a row for every
  later flow. A flow that assumes fresh state and does not establish it is broken, not flaky.
- **A testID built from transient state renames itself.** The feed's section header was keyed
  to the SECTION, so the same visible header answered to `-idle` or `-needs-you` depending on
  whether a prompt was pending. Key selectors to something that cannot move.
- **An armed confirmation must not expire on a clock.** The delete row swaps its own testID when
  armed and used to relax after 10s. Maestro spends SECONDS between two taps ("settled
  hierarchy" aiming), so the confirm landed 14.8s after the arm, the row had already disarmed,
  and the second tap re-armed instead of confirming - no request, no error, and a screenshot
  showing an unarmed row.

  That screenshot is the trap: **an unarmed row looks identical whether the arm never landed or
  the arm landed and self-expired.** An earlier revision of this rule asserted the first, and it
  was wrong. Asserting the armed state between the taps does not distinguish them either - it
  passed, and the row expired afterwards. Only the timestamps in
  `~/.maestro/tests/<timestamp>/maestro.log` separate the two.

  The fix was to delete the deadline, on product grounds: an accidental double-tap fires the
  delete whatever the window is, because the guard is the SECOND TAP, not the clock. The expiry
  protected nothing and punished the reader who paused over the consequence line.

**Never raise a timeout as a first move**, and never change product behaviour to make a flow
pass without giving the product argument on its own merits.

**The app never reports UI-idle, and it costs every tap 6-8 seconds.** `adb shell uiautomator
dump` fails with `could not get idle state` whenever the app is foregrounded, on Board and Home
alike, and succeeds the instant it is backgrounded. Maestro therefore falls back to "settled
hierarchy" aiming before every tap. This is the single largest drag on suite runtime and it
caused at least one real failure (the delete confirmation expiring between two taps). The cause
is NOT an obvious animation loop - there is no `Animated.loop` or infinite `withRepeat(..., -1)`
in `src/`. Treat a mysteriously slow flow as a symptom of this before assuming the flow is wrong.

**Leading suspect is the emulator image, not the app.** The local AVD runs `google_apis`, and
that image is already on record starving this app in CI - where it failed 3 of 4 runs and looked
exactly like an app bug. Test a `default`-image AVD before hunting in `src/`.

## Enforcement (self-maintaining)

- **Review (live now):** `/code-review` flags MCP-run invocations and label selectors in
  `.maestro/**` diffs.
- **Agent (live now):** `e2e-flow-doctor` diagnoses a failing or flaky flow against this rule
  and is the intended first responder for a red suite.
- **Skill (live now):** `/e2e` runs the suite in the order that actually works - APK-matches-HEAD
  check, rebuild, one rig mode, pair WITH the URI, run, triage through the agent. Two of tonight's
  wasted runs were pure sequence errors, not judgement.
- **Test (live now):** `tests/unit/rigProcessRegistry.test.ts` unit-tests the kill/prune decision
  (recycled pid, missing identity, dead process) and statically scans `scripts/dev.mjs` for a
  kill target derived from a command line. The scan is the enforcement that matters: the failure
  mode is a REINTRODUCED pattern, which no runtime test can catch.
- **Test (live now):** `tests/unit/maestroFlows.test.ts` statically checks every flow for unknown
  commands, a missing `appId`, and a sub-45s `session-screen` wait, in under a second. An unknown
  command is a PARSE error that aborts the whole suite before any flow runs, so catching it in CI
  rather than 15 minutes into a run is the difference. It carries an explicit
  non-vacuity guard, because a scan that silently stops matching is worse than no scan.
- **Docs (live now):** `docs/developer-guide.md`'s "Running the E2E suite" section carries the
  full reasoning, the measured cost of each workaround, and the build-profile change that would
  remove them.
- **Test (planned):** a scan of `.maestro/**` for `tapOn`/`assertVisible` on a bare string that
  matches a label in `src/screens/**` or `src/components/**`, which is the mechanical form of the
  testID rule above.

**Prefer the `e2e` build profile over the dev client.** `eas.json`'s `e2e` profile builds a
release-shaped binary carrying `EXPO_PUBLIC_KANGENTIC_E2E=1`, the second build-time gate on the
`ws://10.0.2.2` carve-out in `src/pairing/qr.ts`, so it reaches a local rig relay without
`__DEV__`. Against that binary none of the three dev-client constraints above exist. Reach for
the dev client only when authoring a flow and wanting Fast Refresh.

**Build that binary from a SHORT-PATH worktree, never from `.kangentic/worktrees/`.** Any build
started from the normal worktree dies on CMake's 250-character object-path cap inside
`node_modules/<pkg>/android/.cxx/` (208 characters before the filename), at every variant, and a
directory junction does not dodge it because Node realpaths `node_modules`. A git worktree whose
real path is short does: `git worktree add --detach C:\kw HEAD`, `npm install`, prebuild, then
gradle with `-PreactNativeArchitectures=arm64-v8a`. Full recipe in `docs/developer-guide.md`.
A cloud build is therefore no longer required for an `e2e` APK - and remains a **cloud-spend
decision the user makes**, never something to fire off to unblock a flow.

## Scope

`.maestro/**` and the two scripts that drive it. Widening the relay carve-out further is a
security change, not a testing one: read `docs/security.md`'s relay-scheme paragraph first, and
keep every gate build-time. A runtime toggle for it would be a defect.
