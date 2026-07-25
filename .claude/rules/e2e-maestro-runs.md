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
- **A flow that calls itself self-contained must be.** The stub peer restores its canned board on
  every session establish, which is one flow; do not add state that outlives that boundary.

## Enforcement (self-maintaining)

- **Review (live now):** `/code-review` flags MCP-run invocations and label selectors in
  `.maestro/**` diffs.
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

## Scope

`.maestro/**` and the two scripts that drive it. Widening the relay carve-out further is a
security change, not a testing one: read `docs/security.md`'s relay-scheme paragraph first, and
keep every gate build-time. A runtime toggle for it would be a defect.
