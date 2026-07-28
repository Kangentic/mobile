---
description: Run tests, audit coverage, or write missing tests across the React Native tiers
allowed-tools: Read, Glob, Grep, Task, Bash(npm:*), Bash(npx:*), Bash(git:*), Bash(maestro:*), Bash(adb:*)
argument-hint: [quick|unit|components|e2e|audit|write]
---

# Test - Local Test Gate

A fast, predictable local gate over the React Native test tiers. **The skill runs tests
directly but delegates all test-writing and coverage analysis to the `test-builder` agent**
(`.claude/agents/test-builder.md`), the single source of truth for tier classification and
anti-flake patterns. This skill does not re-implement that knowledge inline.

**Usage:** `/test [mode]`

| Argument | Mode | Description |
|----------|------|-------------|
| *(none)* | **Full gate** | typecheck -> unit + components (parallel) -> Maestro E2E -> coverage audit |
| `quick` | **Quick** | typecheck -> unit + components (parallel). No E2E. Fast inner loop. |
| `unit` | **Unit only** | typecheck -> unit |
| `components` | **Components only** | typecheck -> components |
| `e2e` | **E2E only** | typecheck -> Maestro flows against the Android emulator |
| `audit` | **Coverage audit** | Delegate to `test-builder` (audit-only). No test execution. |
| `write` | **Write tests** | Delegate to `test-builder` to audit and implement missing tests. |

**Selected mode:** $ARGUMENTS

## Mode: Full gate (`/test`)

1. **Typecheck (gate).** Run `npm run typecheck`. If it fails, report and **stop**.
2. **Launch in parallel** (each command its own Bash call): `npx vitest run tests/unit` and
   `npx jest tests/components`.
3. **E2E.** Confirm an emulator is attached (`adb devices`); if none, skip E2E and note it in
   the report. Otherwise run the two suites separately (see "The two Maestro suites" below):
   `maestro --device <serial> test .maestro/smoke.yaml`, then, only if the paired rig is up,
   `maestro --device <serial> test .maestro/paired`. If the rig is not up, run smoke and say
   plainly in the report that paired was skipped.
4. **Coverage audit.** Gather `git diff` context and launch a single `test-builder` agent in
   audit-only mode (see "Coverage delegation"). Relay its report.
5. Present results in the Reporting Format below.

---

## Mode: Quick (`/test quick`)

1. Run `npm run typecheck`. Stop on failure.
2. In parallel (separate Bash calls): `npx vitest run tests/unit` and `npx jest tests/components`.

## Mode: Unit only (`/test unit`)

1. `npm run typecheck`. Stop on failure.
2. `npx vitest run tests/unit`.

## Mode: Components only (`/test components`)

1. `npm run typecheck`. Stop on failure.
2. `npx jest tests/components`.

## Mode: E2E only (`/test e2e`)

1. `npm run typecheck`. Stop on failure.
2. `adb devices` - if no emulator/device attached, report and stop.
3. Run the suites separately, never the bare root (see below). Smoke:
   `maestro --device <serial> test .maestro/smoke.yaml`. Paired, only with the rig up:
   `maestro --device <serial> test .maestro/paired`. A single flow:
   `maestro --device <serial> test .maestro/paired/<flow>.yaml`.

## The two Maestro suites, and why never the bare root

**Never `maestro test .maestro/`.** The root holds three things, and only two are suites:

| Entry | What it is | How to run it |
|---|---|---|
| `.maestro/smoke.yaml` | 1 flow, fresh unpaired install, no relay and no pairing. What the required `E2E Tests (Maestro)` check gates on | `maestro --device <serial> test .maestro/smoke.yaml` |
| `.maestro/paired/` | 11 flows against a relay plus `scripts/stubDesktopPeer.mjs`, pairing completed first. Reports as the advisory `E2E Tests (Paired)` check | `/e2e` sequences the setup. Direct: `maestro --device <serial> test .maestro/paired` |
| `.maestro/setup/` | NOT a suite. A rig fixture needing a `PAIRING_URI` handed to it | Never directly. `run-maestro-paired.sh` invokes it by name |

A bare `.maestro/` root sweeps in the `setup/` fixture, which then fails for lacking `PAIRING_URI`
and reads as a broken pairing screen rather than a misconfigured command. It also runs the paired
flows with no relay and no stub. `tests/unit/ciSafeMaestroFlows.test.ts` fails CI if a workflow
ever points at the bare root, for exactly this reason.

**iOS E2E does not exist, by any route.** Not locally (no Mac) and not in CI. An earlier version
of this line claimed iOS Maestro flows "run on cloud simulators via EAS Workflows in CI", which was
never true: there is no `.eas/workflows/` directory in this repo on any branch, so nothing was ever
wired. `docs/developer-guide.md` debunks it at length and `README.md` says the same; this file was
the last place still repeating it.

What DOES exist for iOS is `build-ios.yml`'s simulator job, which compiles the app, launches it,
and uploads a screenshot. That is a compile-and-launch smoke check, not a flow suite, and it is
dispatch-triggered rather than part of any test tier.

---

## Mode: Coverage audit (`/test audit`)

1. Gather context locally (each in its own Bash call): `git diff --staged`, `git diff`,
   `git status`.
2. Launch a single `test-builder` agent in audit-only mode.
3. Relay the report verbatim.

## Mode: Write tests (`/test write`)

1. Gather context locally: `git diff --staged`, `git diff`, `git status`.
2. Launch a single `test-builder` agent in write mode, passing the diff.
3. Relay the agent's summary. Flag any gaps it could not fill.

---

## Coverage delegation

All coverage analysis and test writing go to one `test-builder` agent. The skill gathers
`git diff` context and hands it off; it does not duplicate the agent's tier decision tree.

- **Audit-only:** prompt includes the changed files/diff plus: **"Audit-only mode. Read each
  changed file, apply your tier decision tree, and return the standard Coverage Gaps report. Do
  NOT write any tests."**
- **Write:** prompt includes the diff plus: **"Write mode. Audit coverage, then implement the
  missing tests following your tier rules and anti-flake patterns. Derive expected behavior from
  the task intent, red-green verify each new test, and validate Maestro flows with multi-run
  stability checks. Report tier chosen per file, files modified, and red-green + stability
  results."**

---

## Reporting Format (run modes only)

**Never use emojis** - they render as broken boxes in the terminal. Use plain text only.

```
## Test Results

| Tier       | Status | Notes            |
|------------|--------|------------------|
| Unit       | PASS   | 12 tests         |
| Components | PASS   | 4 tests          |
| E2E        | PASS   | 3 flows          |

All green. No regressions.
```

Only include tiers that ran. Use `PASS`, `FAIL`, or `SKIPPED`. On failures, add a `### Failures`
section listing each failing test, the error, and a likely cause.

---

## Rules

- **Model selection.** The `test-builder` agent runs on Sonnet (set in its frontmatter).
- **Test implementation is delegated to `test-builder`.** This skill runs tests and presents
  results; it does not write tests inline, except a trivial single-line addition to an existing
  passing test.
- **No chained commands.** No `&&`, `||`, `|`, `;`, or stderr redirection.
- **No `cd && git`.** Use `git -C <path>` to target another directory.
- **Typecheck is a gate.** Always typecheck first; stop immediately on failure.
- **Use dedicated tools.** `Read`, `Glob`, `Grep` for file operations. Reserve `Bash` for `npm`,
  `npx`, `maestro`, `adb`, and `git` only.
