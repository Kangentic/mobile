---
description: Investigate a Sentry issue - retrieve the issue, latest event, stack trace, tags and breadcrumbs from the kangentic org's `mobile` project and diagnose it. Use when a task or the user says to investigate/look at/diagnose a Sentry issue or link, to check what errors are arriving, or to triage Sentry before a release (a sweep ends by filing the actionable issues as grouped, parallel-safe board tasks).
allowed-tools: Read, Glob, Grep, Bash(npx -y sentry@0.46.0:*), PowerShell(npx -y sentry@0.46.0 *), PowerShell(Invoke-RestMethod:*), PowerShell(Invoke-WebRequest:*), Bash(curl:*), mcp__kangentic__kangentic_search_tasks, mcp__kangentic__kangentic_find_task, mcp__kangentic__kangentic_create_task, mcp__kangentic__kangentic_update_task
argument-hint: [issue id, Sentry URL, or "any new issues?"]
---

# Sentry

Retrieve and diagnose issues from the `kangentic` Sentry org (`kangentic.sentry.io`). This
repo's project is `mobile` (numeric id `4511808149651456`); the desktop app's project (`desktop`,
`4511996066660352`) belongs to the desktop repo's own copy of this skill. Crash reporting is
wired in `src/observability/crashReporting.ts`; `.claude/rules/crash-reporting-scope.md` and
`docs/security.md` describe what gets captured and how.

This skill and the desktop repo's `/sentry` are deliberately separate copies (different
projects, different symbolication stories). Do not try to unify them. The retrieval mechanics
(the `sentry` CLI, the narrow login, the auto-mode rules in `.claude/settings.json`) and the
grouped sweep filing were ported from the desktop copy on 2026-10-05; the diagnosis material
below is mobile's own.

## Auth (never print a token)

Retrieval goes through Sentry's own `sentry` CLI (see Retrieval), which signs in once through the
browser and stores a refreshing OAuth login in `~/.config/sentry`. You should not need to repeat
it. `npx -y sentry@0.46.0 auth status` says whether the login is live and which credential is in
use; the stored login wins over a `SENTRY_AUTH_TOKEN` in the environment, so the CI upload token
a build machine has set is ignored. Every call prints a one-line notice that it found a token in
`.sentryclirc` and is using the stored login instead. That notice is harmless.

Reading needs `event:read` + `project:read` + `org:read`. Assigning (the triage marker, below)
also needs `event:write`. The default write grant also covers admin on projects and teams, so
when an assign returns 403, ask the user to re-login with the narrow one, which replaces any
earlier login:

```
npx -y sentry@0.46.0 auth login --force --scope project:read,org:read,event:read,member:read,team:read,event:write
```

Login is interactive (a browser round trip), so it is the user's to run, as `! npx -y sentry@0.46.0
auth login ...` in the prompt.

**Do not read `~/.sentryclirc`, with any tool, ever.** It holds the CI sourcemap-upload token
(`org:ci`), which 403s on every read endpoint, so it buys nothing; and a command that greps a
token out of a dotfile is what the auto-mode classifier flags as credential exploration, which
stalls a sweep mid-run. The raw-API fallback (below) takes its bearer token from
`KANGENTIC_SENTRY_TOKEN` only.

## Retrieval

Parse the issue id from a pasted URL: `https://kangentic.sentry.io/issues/<ISSUE_ID>/?...` (a
`project=` query param, if present, is the numeric project id).

**Always call the CLI as `npx -y sentry@0.46.0`, never bare `sentry`.** The npm package `sentry`
(published by Sentry, pre-1.0) is the CLI this skill means. A machine that also has the older
upload tool (`sentry-cli`, from scoop, Homebrew, or the `@sentry/cli` dependency) resolves bare
`sentry` to that one, which prints `sentry-cli 3.x` and understands none of these commands - the
maintainer's machine does exactly this. The pinned npx form resolves the right package every time
(Node 20+), and it matches this repo's existing `npx` permission rules.

**Target the project by its NUMERIC id, never the slug**: `kangentic/4511808149651456`. The slug
already renamed once (`react-native` to `mobile`, 2026-08) and can again; the numeric target was
checked against the CLI and returns the same issues. An issue target is its shortId
(`kangentic/MOBILE-9`), which every command here accepts - but see the shortId note under the
duplicate guard, since a shortId is derived from the CURRENT slug.

One command per call:

```
npx -y sentry@0.46.0 issue list kangentic/4511808149651456 --query "is:unresolved is:unassigned environment:production" --json --fields shortId,title,level,count,userCount,firstSeen,lastSeen,assignedTo
npx -y sentry@0.46.0 issue view kangentic/MOBILE-9 --json --fields event.tags,event.contexts.os,event.contexts.device.model,event.contexts.app.app_version,event.contexts.app.app_build,event.contexts.app.in_foreground
npx -y sentry@0.46.0 issue view kangentic/MOBILE-9
npx -y sentry@0.46.0 api organizations/kangentic/issues/MOBILE-9/tags/release/
npx -y sentry@0.46.0 auth whoami --json --fields id
npx -y sentry@0.46.0 api organizations/kangentic/issues/MOBILE-9/ -X PUT -f assignedTo=user:<id>
```

- **`issue list`** returns 25 rows from the last 30 days by default (`-n 100`, `--cursor next`,
  `--period`). `--query` takes Sentry issue search syntax; the query above is the triage set.
  `environment:production` in the query does narrow it (checked: it drops the `crash-test`
  issues). On the raw API, verify an `environment` filter actually narrows the result before
  trusting it; if it looks inert, read `environment` off each issue's latest event instead.
- **`issue view --json --fields`** is the default way to read an event. The list above was
  checked on a real event. Request app fields one by one rather than `event.contexts.app` whole,
  which dumps the full Android permission list. Never request `event.user` or
  `event.contexts.device.id`: both carry the per-install identifier (see Boundaries).
- **`issue view` without `--json`** is the readable form: a header table (status, events, users,
  first and last seen), tags, the user's install id and location, the breadcrumbs, and the stack
  with the innermost frame first. Use it to READ a stack and its breadcrumbs. Its install id and
  location lines are exactly what Boundaries forbids pasting anywhere, so never copy from it
  wholesale.
- **Always give `--json` a `--fields` list.** Bare `--json` prints the whole raw event.
- **Release breakdown** is one `api` call per issue and key (`release`, `environment`). It is what
  spots a recurrence on the newest build. Sentry allows about ten of these per window, so a long
  list needs spacing.
- **`api` GET parameters** go in as `-f key=value`, for example
  `npx -y sentry@0.46.0 api organizations/kangentic/issues/ -f project=4511808149651456 -f query=release:com.kangentic.mobile@0.8.1+14 -f limit=100`.
  A query string written into the path was ignored in testing (desktop).
- **Assigning** is the PUT above, with your own user id read at runtime from `auth whoami`. Never
  write a user id, email, or name into this file or a task: the repo is public.

**What reaches the output unscrubbed.** Nothing in this repo rewrites the CLI's output, and no
server-side Data Scrubbing rule is documented for the mobile project (the desktop project's rule
is the desktop's own; do not assume it here). What this app's events can carry is set at the source and documented
in `.claude/rules/crash-reporting-scope.md`'s "Known limitations": a native-captured event's
per-install `user.id`, and the uncaught path's exception message, which for a `CapabilityError`
is a desktop-supplied string verbatim. So never paste the readable view's Message, an exception
value, a breadcrumb, or a stack line into a task or a reply. Describe the error in your own words
and cite frames by module and line (`capabilityClient.ts:<line>`).

### Raw-API fallback

For what the CLI leaves out (the `debugmeta` images, the `threads` entry, the issue `activity`
array), call the REST API with a bearer token from `KANGENTIC_SENTRY_TOKEN`: the process
environment first, then, on Windows, the User-level registry value, which a process tree started
before the variable was set cannot see as `$env:`. Resolve and use it in the SAME command, since
shell state does not persist between calls; never echo it, write it to a file, or put it in a
reply, task, or commit:

```powershell
$token = $env:KANGENTIC_SENTRY_TOKEN; if (-not $token) { $token = [Environment]::GetEnvironmentVariable('KANGENTIC_SENTRY_TOKEN','User') }; Invoke-RestMethod -Uri 'https://sentry.io/api/0/organizations/kangentic/issues/<ISSUE_ID>/' -Headers @{ Authorization = "Bearer $token" } | ConvertTo-Json -Depth 8
```

macOS/Linux (Bash, one command): `curl -s -H "Authorization: Bearer $KANGENTIC_SENTRY_TOKEN" <url>`.

No token set means the fallback is unavailable; say so and continue with what the CLI returned.
A `403` from every endpoint means the token is CI-scoped: stop and ask the user to mint a
read-scoped User Auth Token rather than retrying.

Endpoints, always by **numeric project id, never the slug**:

| What | Endpoint |
|---|---|
| Issue summary (title, culprit, count, userCount, firstSeen/lastSeen, level, substatus) | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/` |
| Latest event (stack trace, tags, breadcrumbs, contexts, release) | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/events/latest/` |
| All events for the issue | `GET /api/0/organizations/kangentic/issues/<ISSUE_ID>/events/` |
| Search issues (mobile project) | `GET /api/0/organizations/kangentic/issues/?project=4511808149651456&query=is:unresolved&statsPeriod=14d&sort=date` |
| Events across the project in a window (does anything exist near a reported time?) | `GET /api/0/organizations/kangentic/events/?project=4511808149651456&statsPeriod=3d&field=timestamp&field=title&field=environment&field=release&field=os.name&sort=-timestamp` |
| Assign an issue (the triage marker, see below) | `PUT /api/0/organizations/kangentic/issues/<ISSUE_ID>/` body `{"assignedTo":"user:<USER_ID>"}` |

The events query answers "did anything at all arrive around 10:29?" when a user reports a
symptom with no issue link. An empty window is only a result once the same query over a wider
window returns known events: an empty answer from a malformed query looks identical.

The latest-event payload is large; extract what you need rather than dumping it: `entries`
with `type: "exception"` carries the stack frames, `type: "breadcrumbs"` the trail, `tags`
carries `environment`, `release`, and the per-install identifier under `user.id` (see
Diagnosis below - it is not always present, and its presence is itself diagnostic).

## The two flows

### "Any new issues?" (triage scan)

Run the `issue list` line from Retrieval. It keeps only unresolved, unassigned production issues,
so its rows are most of the report's per-issue line: shortId, title, count, userCount (affected
installs), first and last seen, level. Add the link (`https://kangentic.sentry.io/issues/<id>/`)
and the release breakdown for any issue you will report. Then run it again without
`is:unassigned` to catch a RECURRENCE: an assigned issue with events on a release newer than the
fix is the loudest thing a sweep can find (see the duplicate guard).

`crashReporting.ts` sets exactly four environment values, not two: `development`, `crash-test`,
`e2e`, or `production`. A Maestro APK is release-shaped (`__DEV__` is false) and reports as `e2e`,
which is exactly as much noise as `development` - a dispatched E2E run is not a user's device.
`crash-test` is a `crash_test` dispatch of either build workflow: deliberate crashes driven from
the Settings crash rows, on a CI simulator or a maintainer's device, never a user's. It has its
own value rather than riding `production` because such a build carries the SAME release string as
the shipped build it was cut from. If non-production issues are worth mentioning at all, report
them in a clearly separate block, never interleaved with production issues.

**"New" means new to the user: an unassigned issue whose shortId appears in no board task.**
Assignment is the triage marker, so an assigned issue is never reported as new. Still confirm
with the board search, because assignment can be stale and a task can exist without one.

**The duplicate guard must search both shortId prefixes.** Sentry derives an issue's shortId
from the project's **current** slug, computed live, not fixed at creation time. This project's
slug renamed `react-native` to `mobile` in 2026-08, which silently rewrote every pre-rename
issue's shortId from `REACT-NATIVE-N` to `MOBILE-N`. Board tasks filed before the rename still
carry the old prefix in their titles (e.g. task #48 titles `REACT-NATIVE-3/4/5`, which Sentry
now reports as `MOBILE-3/4/5`). So for an issue Sentry reports as `MOBILE-N`, search
`kangentic_search_tasks` for **both** `MOBILE-N` and `REACT-NATIVE-N`; a hit on either prefix
means it is already tracked. Skipping this re-files every pre-rename issue as new. The search
covers completed tasks too - a completed task means the issue was already handled, so if Sentry
still shows it unresolved, say that explicitly rather than silently dropping it from the report.

A completed task plus a still-recurring issue is the case worth calling out loudest: check the
event releases against the build that carried the fix before saying it is handled. Task #48 is
the precedent - it fixed MOBILE-3, and MOBILE-3 crashed again on a later build that contained
the fix.

**Then file the actionable issues as board tasks, grouped.** A sweep ends on the board, not in a
report the user has to turn into tasks by hand, so file without a separate ask unless the user
said to only list or only diagnose. Diagnose each candidate first (Diagnosis below): what gets
filed is a fix with a known throw site or a concrete lead, never "look into X". The user runs
these tasks in parallel worktrees and prefers fewer, larger ones, so:

- **Group by the files the fix touches.** Issues whose fixes land in the same files go in one
  task even when their mechanisms differ. Two worktrees editing the same files conflict at merge,
  which costs more than one larger task.
- **Split only where the files are disjoint.** That is the one reason for a second task. Issue
  count, severity, and subsystem name are not.
- **Make each task self-contained.** Parallel agents share no context, so each description
  carries its own diagnosis, evidence, the fields listed under the next flow, and a "Done when"
  naming the regression test that proves the fix (which must fail first, per
  `.claude/rules/regression-tests-fail-first.md`).
- **Title a grouped task by its shared cause:** `Fix MOBILE-A, MOBILE-B: <what they share>`.
- **Priority follows impact.** Escalating, many installs, or user-visible first; one event on
  one install with no visible effect last.
- **Do not file what has no fix in this repo.** Each of these gets one line in the report with
  the reason, and no task: `development`/`e2e`/`crash-test` noise; a fix that belongs in the
  desktop repo or `@kangentic/protocol` (name the repo; a task on THAT board is filed when
  someone starts the work, not by the sweep); an OS kill with no app-side lead (a
  `WatchdogTermination` with no memory evidence); and an issue an unreleased change already
  addresses. They stay unassigned, so offer to archive them in Sentry and do it only on the
  user's OK.

Close the sweep with the filed tasks (number, title, priority, and the files each touches, which
is what shows the set is safe to run at once), the issues not filed and why, and any recurrence
of an assigned issue on the newest release.

### "Investigate this issue" / "create a follow-up task"

Retrieve the issue and its latest event, diagnose it (below), and create a task **only when
asked**. Duplicate-guard first, both prefixes, exactly as above - never re-report or re-file an
issue a search already finds.

One task. Column **`To Do`** (this board has no Backlog column). Title:
`Fix MOBILE-N: <issue title, trimmed>`, using the issue's **actual, current** shortId - never
assume the prefix without checking. Description: the Sentry link, shortId, level, event and
affected-install counts, environment, release, the diagnosis, and only the specific stack
frames or tags that carry it, not a raw event dump (see Boundaries).

### Filing mechanics (both flows)

- **Pass `project: "kangentic-mobile"` on every `kangentic_create_task` call.** The MCP's routing
  check refuses a create whose text names another registered project, and every Sentry link
  contains `kangentic`, so an implicit active-project create fails with a routing error.
- When a `create_task` call carries both a long description and `labels`, the labels can be
  dropped. Create the task first, then set labels in a separate labels-only
  `kangentic_update_task` call.
- **Then assign every issue the task covers**, with the PUT from Retrieval. Filing a task and
  leaving the issue unassigned means the next sweep re-derives the whole cross-reference from
  scratch, which is exactly what the marker exists to prevent. Rules:
  - Assign after the task is created, never before, so a failed create cannot leave a false
    marker.
  - One task can cover several issues. Assign all of them, not just the one that named the task.
  - Assign issues covered by an EXISTING task too when a sweep turns one up unassigned. The
    signal is only useful if it is complete.
  - Never assign an issue with no board task, and never assign `development`, `e2e`, or
    `crash-test` noise. An unassigned issue must keep meaning "nobody has dealt with this".
  - Resolve nothing. Assignment leaves the issue in the unresolved stream where a recurrence
    stays visible, which is the point: a fix that does not hold shows up as new events on an
    assigned issue instead of disappearing.
  - A `403` on the assign PUT alone means the login is read-only: report the issues you could
    not mark and carry on, never let it block the triage.

No `attachments` step here, unlike a video-review task: a Sentry issue has no local artifact to
attach, and attaching a raw event export would violate the no-raw-payload rule below.

A `DESKTOP-*` issue is out of scope - it belongs to the desktop repo's own `/sentry` copy and
its own board.

## Diagnosis (mobile specifics)

- **Native vs JS, one-field discriminator.** A native-captured event carries `platform: java`
  and `mechanism: UncaughtExceptionHandler`, native auto-breadcrumbs (`app.lifecycle`,
  `device.event`, `network.event`), and a `user.id`. A JS-caught event has no `user`,
  `request`, `extra`, or `server_name` at all - `scrubEvent` strips them, and `beforeSend`
  never runs for a native-captured event in the first place. So: an event carrying `user` was
  captured natively; one without was captured in JS.
- **Handled vs uncaught, one-field discriminator.** An event from the handled-error door
  (`reportHandledError` in `crashReporting.ts`) has `mechanism.handled: true` (`type: generic`),
  tags `site`, `errorName` and, for a capability error, `verb`, a title of the form
  `<errorName>: handled at <site>`, and fingerprint `handled|<site>|<errorName>|<verb>`. The
  message is deliberately NOT the original: it is replaced before the SDK sees it, so diagnose
  from the three tags and the frames, and never file "the message is missing" as a bug. Counts
  are lower bounds (one report per site, class and verb per minute, ten per launch, plus the
  SDK's Dedupe). `is:unresolved handled:yes` narrows a query to door events. The `crash-test`
  site is the Settings canary, never a user's failure.
- **Symbolication is four independent paths, all gated on the build's `SENTRY_AUTH_TOKEN`.**
  JS frames (both platforms) resolve only for a release whose Hermes sourcemaps were uploaded
  by the `@sentry/react-native` build integration; an unsymbolicated frame shows the constant
  bundle name (`app:///index.android.bundle` / `app:///main.jsbundle`) - that is the reporting
  path working as designed, not a broken upload. Android Java/Kotlin frames resolve via the R8
  `mapping.txt`, uploaded by the Sentry Android Gradle Plugin. Android native (`.so`) symbols
  are **deliberately never uploaded** - an NDK frame will never resolve; do not read that as a
  failed upload. iOS dSYMs are round-trip verified: a simulator `Sentry.nativeCrash()` arrived
  fully named on 2026-09-12 (MOBILE-7); hardware is unverified. A
  `development`-profile build is the debug variant where R8 never ran, so a readable Java frame
  there proves nothing about the mapping upload.
- **Two known signatures, worth recognizing rather than re-deriving:**
  - A GWP-ASan SIGSEGV (`gwp_asan::GuardedPoolAllocator::deallocate` under
    `android_unsafe_frame_pointer_chase`, `libhermesvm.so` frames beneath, zero app frames) is
    **not a detection** - it is the sampling allocator crashing during its own bookkeeping, not
    an error it found. Suppressed for the e2e APK only; whether it occurs at a meaningful rate
    on production `user` builds is still open.
  - An `OutOfMemoryError` whose Sentry grouping title mentions
    `JSApplicationIllegalArgumentException ... 'backgroundColor' ... RCTView` is a red herring -
    that is the third link in a `Caused by` chain, not the cause. The actual root cause (tracked
    as task #62 at time of writing): every session-screen open leaks its xterm WebView and view
    subtree, which nothing ever releases. Cross-check `firstSeen`/build version before assuming
    a fresh event is the same root cause - it may already be fixed.
- **A silent symptom with no event is not evidence of absence until you check what WOULD report
  it.** A worklet that throws on the Reanimated UI runtime in a RELEASE build is not caught by
  worklets (`callGuarded` exists only under `#ifndef NDEBUG` in
  `react-native-worklets/.../WorkletRuntime.h`), so it would most likely surface as a native
  crash rather than a JS event; a visual glitch that leaves the app running produces nothing at
  all. Task #98 (a stuck pulse tint, 2026-10-05) is the precedent: an empty Sentry window was
  informative only once that was established.
- **Read the breadcrumbs before reasoning about the code.** On a native-captured event
  (`mechanism: UncaughtExceptionHandler`) sentry-android's own auto-breadcrumbs ride along
  unfiltered, so every such event carries a free **lifecycle timeline**: `app.lifecycle`
  foreground/background transitions, `ui.lifecycle` activity states, `device.event`
  (`SCREEN_ON`/`SCREEN_OFF`, `LOW_MEMORY`, battery), `device.orientation`, and `network.event`.
  `.claude/rules/crash-reporting-scope.md` documents these as a privacy LIMITATION; they are also
  the cheapest diagnostic available, and worth reading first on anything lifecycle-shaped (a
  background service, a startup crash, a leak). MOBILE-3 is the precedent: two builds were spent
  guessing at mechanisms, and the breadcrumbs settled it in minutes by showing the app went to
  background and never returned while the process stayed alive 7h10m and 14h14m. Mind the
  clock: the CLI prints UTC (`...Z`), while PowerShell's `Invoke-RestMethod` converts the same
  timestamp to local time (MOBILE-9 read `17:08:24Z` from one and `1:08:24 PM` from the other).
  Put both ends of a gap in the same zone before subtracting, or it is wrong by the offset. A `device.orientation` breadcrumb also implies the display was ON, which
  is how that issue ruled out a timer-starvation theory.
- **Cross-reference locally before concluding.** `Grep` the screen or module named by the top
  frame and read it. `.claude/rules/crash-reporting-scope.md` documents this project's privacy
  controls and their known limitations in detail - read it rather than restating it here.

## Boundaries

- Diagnose and report; fix only when the task explicitly asks for a fix.
- Reads need no ceremony. **Writes are explicit-request-only, with one carve-out**: do not
  resolve, ignore, archive, edit alert rules, or trigger a Seer/autofix run on an issue unless
  the user asks for exactly that. This mirrors the Sentry MCP policy in `CLAUDE.md`'s
  cloud-spend section, which applies to this skill's CLI and API calls just as much as to the
  MCP.
- **The carve-out is assignment**, and only for an issue you just filed a board task for (or one
  an existing task already covers). That write is sanctioned and expected, no separate ask
  needed: it is the marker that makes the next triage sweep cheap. It is also the safest of the
  writes, since it hides nothing and changes no alerting.
- **Filing:** a triage sweep files its actionable issues as grouped board tasks without a
  separate ask, unless the user asked only to list or diagnose. A single-issue investigation
  files a task only when asked.
- **Auto mode:** `.claude/settings.json`'s `autoMode.allow` names exactly what this skill does
  unattended - Sentry reads, and the single-issue assign PUT - and states that DELETEs, bulk
  mutations, settings writes, and other orgs stay classified. If this skill grows a new write,
  add its rule there in the same change, or a sweep will stall on a denial mid-run.
- **Never paste a raw event payload, or a `user.id` / `contexts.device.id` value, into a task,
  commit, PR, reply, or artifact.** Quote only the specific frames and fields that carry the
  diagnosis. Crash events are app data; a native-captured event's `user.id` is a per-install
  identifier that this app's own privacy documentation discloses rather than suppresses (see
  `.claude/rules/crash-reporting-scope.md`) - cite `userCount` (affected installs) instead of
  the identifier itself.
- This repo also has a Sentry **MCP** server wired (`.mcp.json`), which this skill deliberately
  does not use: it requires an interactive OAuth per session. Its URL is also slug-scoped rather
  than org-scoped, so it goes stale on a project rename - it was pinned to the pre-rename
  `react-native` slug, which task #63 corrects. **Read the URL out of `.mcp.json` before
  believing either state**, and do not "simplify" this skill by switching it to the MCP without
  re-checking both points.
