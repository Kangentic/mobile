---
description: Cut an Android or iOS release. Defaults to production on both platforms at 100% (Play full release, App Store auto-release with no phased rollout); arguments pick one platform or another track. Bumps the hand-managed versionCode or buildNumber, drives it through the PR gate, dispatches the CI build, and submits behind the approval gates, which it approves itself only with the user's permission for that release. Refuses the paths that are genuinely blocked rather than failing halfway. Not for a plain merge (use /merge-pull-request) or a build with no release (dispatch the build workflow directly).
argument-hint: [android|ios] [internal|alpha|beta|production|testflight|appstore|artifact] [approve]
allowed-tools: Read, Glob, Grep, Edit, Bash(git:*), Bash(gh:*), Bash(node:*), Bash(npm:*), Bash(npx:*), AskUserQuestion, mcp__kangentic__kangentic_get_current_task
---

# Release

Cut a release of Kangentic Mobile. This sits one rung above `/merge-pull-request`: that lands code
on `main`, this turns `main` into a signed artifact on a store track.

**Usage:** `/release [android|ios] [track] [approve]`

**User-provided arguments (if any):** $ARGUMENTS

## Step 0 - Resolve what release this is

**A bare `/release` means both platforms to production, at 100% of users** (maintainer decision,
2026-10-15). That is the default and the common case, so do not ask what it means. Arguments
narrow it:

| Invocation | Platform | Track | Dispatch |
|---|---|---|---|
| `/release` | both | production | Android `-f submit_track=production`, iOS `-f submit=appstore` |
| `/release android` | android | production | `-f submit_track=production` |
| `/release ios` | ios | App Store | `-f target=device -f submit=appstore` |
| `/release android internal` | android | internal testing | `-f submit_track=internal` |
| `/release android alpha` or `beta` | android | closed or open testing | `-f submit_track=<track> -f rollout=<fraction>`; the `plan` job refuses either without one, so ask for the fraction (default `0.1`) |
| `/release ios testflight` | ios | TestFlight internal | `-f target=device -f submit=testflight` |
| `/release [platform] artifact` | as given, else both | none | `-f submit_track=none` / `-f submit=none` |

`production`, `appstore` and `app-store` are accepted as explicit spellings of the default track.
Use `AskUserQuestion` only for a token that fits none of these. **Production never passes a
`rollout`:** a production release is a full release to every user on both stores, by decision. A
staged Play rollout is still possible by dispatching the workflow by hand with `-f rollout=0.1`,
but `/release` never does it.

**Gate permission.** If `approve` is among the arguments, the user has given permission for this
release's GitHub environment gates to be approved by you (Step 5). Otherwise ask once, now, with
`AskUserQuestion`: "May I approve the store gates for this release?" with three answers:
**Approve all gates** / **Uploads only, I'll approve App Review** / **I'll approve them myself**.
The answer covers **this invocation only** and never carries over to a later `/release`.

Then check the resolved release against the table below and **stop with an explanation if it is
blocked.**

**Every row is a claim about external state, so treat it as evidence with an age, not as fact.**
The table was last revised **2026-10-19**, and each row carries its own date. This matters
because it has already been wrong three times in ways that cost real time: it asserted the Play
API path was proven when nothing had ever exercised it, it listed data safety as unfilled after
it had been submitted, and it still called both production paths blocked weeks after both apps
were live in production. When a row
decides whether you refuse a release, say when it was last verified and against what. If a row
can be checked in seconds with a script, check it rather than quoting it.
Refusing precisely is the job here. Half-executing a blocked release and failing at the upload
wastes a 20 minute build and can leave a dangling Play edit.

| Platform + track | State | What unblocks it |
|---|---|---|
| either + artifact only | **Works** | - |
| android + internal | **Works** | - |
| android + closed (alpha) | **Not exercised** (2026-10-07) | Production access means the closed-test gate was passed, but this workflow has never submitted to `alpha`. The `plan` job requires `-f rollout=...` for it. Treat a first dispatch here the way the production row below treats its first one. |
| android + open (beta) | **Not exercised** (2026-10-07) | Same as closed. |
| android + production | **Works** (2026-10-07; full release proven 2026-10-19) | The app is live in production and production access is granted (maintainer, 2026-10-07). Dispatch `-f submit_track=production` with **no rollout**: a full `completed` release to every user, by maintainer decision (2026-10-15). **v1.0.0 (vc15) is the first release this workflow submitted to production itself**; it and v1.1.0 went out as staged rollouts under the old rule and were widened to 100% by hand (v1.1.0 was at 100% by 2026-10-15). **v1.2.0 (vc17) is the first full `completed` release it submitted** (2026-10-19, run 39182659113, `Submit (Google Play)` in 1m25s, tagged `android-vc17`). Three Console preconditions, all invisible to the Play API: the service account needs **Release to production** under Users and permissions (its July grant was testing tracks only); Publishing overview must hold **no unsent changes**, or the commit fails with "Changes cannot be sent for review automatically"; and **Managed publishing must be off** (it was, checked 2026-10-15), or a committed release waits for a manual Publish. So upload new listing images AFTER the release commits, not before. Either commit failure: fix it, then re-run `submit-play` alone. |
| ios + TestFlight internal | **Works** | Needs `ASC_API_KEY_BASE64` + `ASC_KEY_ID` + `ASC_ISSUER_ID`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`, as GitHub secrets. Check with `gh secret list` before promising it. |
| ios + TestFlight external | **Unverified since 2026-07-28** | Then: needs a Beta App Review plus a beta description, feedback email, and test information. Not revisited since; check App Store Connect. |
| ios + App Store | **Works end to end** (2026-10-19: v1.2.0 build 19 reached WAITING_FOR_REVIEW through both stages, run 39182661900) | The app is live on the App Store (maintainer, 2026-10-07). Dispatch `-f target=device -f submit=appstore`. Two stages, each behind its own approval of `app-store-connect`. **Stage 1**, at the end of `Submit (TestFlight)`, creates or updates the App Store version, attaches the build, fills What's New from `store/whatsnew/whatsnew-<locale>`, sets **release automatically after approval** and cancels any planned **7-day phased release**, then reports the review notes, contact details and screenshot counts. **Stage 2**, `Submit (App Review)`, re-applies those settings, refuses without review notes or screenshots, and submits. Rejecting the second gate leaves a draft version, which can still be submitted by hand with Add for Review. **Needs the ASC API key on the App Manager role**; stage 1 answers a 403 with exactly that. Both active team keys were App Manager when checked (2026-10-15), so this should hold unless the key is replaced. A version created through the API **inherits** the previous version's screenshots and App Review Information (the notes carry the reviewer demo pairing code): 1.2.0 arrived with 7 screenshots, contact details and notes, and stage 1's carry-over (since 2026-10-18) found nothing to copy. The carry-over stays as a safety net; when it does copy, the report names the fields (`Changed: App Review Information carried over from version ...`). **Screenshots stay manual:** when a release needs new ones, upload them between the two approvals. Seven 6.9-inch frames at 1320x2868 are tracked in `store/screenshots/ios/iphone-6.9/`, against an Apple minimum of **one** (10 is the cap, and only the first 3 reach install sheets). Upload via Media Manager targeting 6.9", the source slot every smaller iPhone size is derived from. `ITSAppUsesNonExemptEncryption` is `false` as a reasoned default, not a verified legal conclusion; see the comment in `app.config.ts`. |

If the user insists on a blocked path after being told, say plainly that it cannot be done and stop.
Do not attempt a workaround.

**One thing to say out loud for any iOS release: the push extension is still unproven on
hardware.** The app itself is past that: TestFlight testers have run it on physical iPhones since
the 0.4.x builds, and it is live on the App Store. What no check here has proven is the
Notification Service Extension's execution, which decrypts a push before iOS renders it. Its
crypto is cross-checked against `@kangentic/protocol` by the `NSE crypto (swiftc)` job, but a
**simulator cannot prove the extension runs at all**: `simctl push` is delivered as a local
request with no service-extension step. Only a real APNs push to a real device can, so do not
describe encrypted iOS push as verified until one has.

## Step 1 - Preflight

All of these, and stop on any failure:

- `git status --porcelain` is empty, and the checkout sits exactly at `origin/main`: after
  `git fetch origin --tags`, `git rev-parse HEAD origin/main` prints the same commit twice. A
  release is cut from `main`'s content, never from unmerged task work. **In a board worktree, do
  not check out `main`** (the main checkout holds it) **and do not create or switch a local
  branch.** The worktree's own branch is the board's session identity, and `/pull-request` Step
  1.5 forbids renaming it. If `HEAD` is behind, `git rebase origin/main` moves it forward.
- `npm run check:install` passes. A board worktree starts with `node_modules` linked to the main
  checkout's, which can hold an older `@kangentic/protocol` than `package.json` asks for (v1.2.0
  found 0.20.0 against `^0.23.0`), and then typecheck fails in files the release never touched.
  `npm install` fixes it; run it before `/pull-request`, not halfway through it.
- `main`'s own CI is green: `gh run list --workflow ci.yml --branch main --limit 1`.
- The platform's secrets exist (`gh secret list`):
  - **Android:** `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
    `ANDROID_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON`, `PLAY_SERVICE_ACCOUNT_JSON`. Without the keystore
    the workflow silently degrades to a debug-signed APK, which is useless for a release.
  - **iOS:** `IOS_DIST_CERT_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`,
    plus either the `ASC_*` trio or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` if uploading. A device
    build fails immediately on a missing secret rather than degrading, so this preflight only saves
    time; it is not load bearing. **An App Store release (`submit=appstore`) needs the `ASC_*`
    trio specifically**, with the key on the **App Manager** role. The app-specific password can
    upload but cannot reach the App Store Connect API, and the `device` job refuses `appstore`
    without the key. `gh secret list` cannot show the role; a 403 from stage 1 is how a missing
    one shows up.
- **For an App Store release, run the read-only preflight first:**
  `gh workflow run app-store-check.yml --ref main`, then read its job summary. It writes nothing.
  It proves the key authenticates and that the reads both stages start with still answer, and it
  reports the newest version's App Review notes, contact details and screenshot counts, plus any
  other unreleased version (a draft, or one in review or waiting to release) that would make stage
  1 refuse. Stop and tell the user if it fails, or if it reports an unreleased version. Missing
  review notes or screenshots are the user's to fix in App Store Connect, before stage 2 at the
  latest. It cannot prove write access; the App Manager role can.
- The approval environment for the chosen platform still has a required reviewer:
  `gh api repos/Kangentic/mobile/environments --jq '.environments[] | {name, rules: [.protection_rules[].type]}'`
  must show `required_reviewers` on `google-play` (Android) or `app-store-connect` (iOS). **A missing
  environment is silently auto-created with no protection**, which turns the gate into a no-op with
  no error anywhere.

## Step 2a - Ask for the semver bump

`version` in `app.config.ts` is the user-facing version name (`1.2.0` as of 2026-10-19) and is
hand-managed. Ask with `AskUserQuestion`: **major / minor / patch / none**.

Guidance to give when asking, since the right answer depends on what landed since the last release:

- **patch** - fixes and internal work only, no behaviour a user would notice.
- **minor** - new user-visible capability, backward compatible. The normal bump for a release that
  ships a feature (v1.1.0 and v1.2.0 were both minor).
- **major** - reserved for a break users would feel, such as a phone that stops working with a
  desktop it used to pair with. `1.0.0` was spent on the first public release (2026-10-08).
- **none** - re-releasing the same version with a new build. Legitimate when the previous artifact
  was broken, and the only case where `version` stays put while `versionCode` still must increase.
  **Not valid for an App Store release once that version string is live:** Apple needs a new
  version string for every App Store release, and stage 1 refuses a live one. It is fine for
  TestFlight, and for an App Store version that was rejected or never submitted.

Two things that are NOT the app version and must not be bumped in sympathy: the
`@kangentic/protocol` package version (published from the desktop repo, see
`.claude/rules/protocol-types-from-package.md`) and `package.json`'s `version`, which is inert for a
`private: true` app that is never published to npm.

## Step 2b - Resolve the build identifier

Both platforms have a hand-managed build counter (`cli.appVersionSource` is `"local"`, which is
CLI-wide and not Android-only), so nothing increments either one and both stores reject a duplicate.
Each is an integer with **no relation to semver**: it increments on every single upload, including a
`none` semver bump.

**The normal path needs no store key.** Read the spent counters from the remote tags (below), take
the next number after each, and let `Release counters (stores)` on the release PR ask both stores:
it is a required check and runs the same two scripts with CI's secrets. That is how v1.2.0 was
resolved (vc17 after `android-vc16`, b19 after `ios-b18`). A session normally holds neither key,
and auto mode refuses the Play service-account key outright, so do not plan a step around one.

**Android** - `android.versionCode`:

1. Read the local value from `app.config.ts` and the highest `android-vc*` tag.
2. The next code is `max(local, highest tag) + 1`. Using local+1 alone is wrong: a release can have
   been cut from another machine.
3. Only with the key on hand, ask Play directly:
   `node scripts/checkPlayVersionCode.mjs --key <path to play service account json> --package com.kangentic.mobile --version-code <local value>`

**iOS** - `ios.buildNumber`:

1. Read the local value from `app.config.ts` and the highest `ios-b*` tag.
2. Apple requires the build number to be unique **per version string**, not globally increasing, so
   after a semver bump it may legally restart. In practice it has kept increasing across versions
   (b18 was 1.1.0, b19 is 1.2.0), and continuing from the highest tag is always safe.
3. Only with the key on hand, ask App Store Connect directly:
   `node scripts/checkAppStoreBuild.mjs --key <AuthKey.p8> --key-id <id> --issuer-id <id> --bundle-id com.kangentic.mobile --version <version> --build-number <local value>`

Either key lives outside the repo; see the credential inventory in `docs/developer-guide.md`. The
workflows run the matching check themselves before building, so this step is about telling the user
the number in advance, not about enforcement.

Report both the local and the store-side numbers before changing anything.

**Read the tags, not the comments.** Every successful submit now records what it spent:
`git tag --list 'android-vc*'` and `git tag --list 'ios-b*'`. Those are written by the submit jobs
after the upload lands (for iOS, after Apple *accepts*), so they cannot drift. The comments in
`app.config.ts` are maintained by hand and are a courtesy, not a source of truth. A stale one is
exactly what sent the 2026-07-28 release at an iOS build number Apple had already taken.

**Two ways an empty tag list lies to you, both hit on 2026-07-29:**

1. **`git tag --list` reads LOCAL tags.** The submit job creates the ref on the remote, and a
   checkout that has not fetched since shows nothing. `git fetch --tags` first, or ask the remote:
   `gh api repos/Kangentic/mobile/git/matching-refs/tags`.
2. **The tagging step postdates the releases before it.** It landed in `5adf180` at 17:20 UTC on
   2026-07-28; android vc2 was submitted at 06:22 UTC that morning and ios build 4 the same day,
   so neither was tagged by CI. `android-vc2` was backfilled by hand at `4d2135b`. Absence of a
   tag for anything released on or before 2026-07-28 means nothing. From vc3 and ios build 5
   onward the tag is authoritative.

**Three places now catch a spent counter, in increasing cost:**

1. `Release counters (stores)` in `ci.yml`, on any PR that changes a counter's value.
   Seconds, and it is where a bad bump should die.
2. The `plan` job in `build-android.yml` and the pre-archive check in `build-ios.yml`. Both run
   before anything expensive.
3. The submit jobs themselves, which re-check to close the window where another machine took the
   number mid-build.

(1) **is** a required status check on `main` as of 2026-07-28, so a spent counter blocks the merge
rather than merely reporting. Confirm rather than assume when it matters:
`gh api repos/Kangentic/mobile/branches/main/protection/required_status_checks --jq '.contexts'`.
Note it runs on `pull_request` only, so a counter bumped by a direct push to `main` never passes
under it.

## Step 3 - Land the bump through the PR gate

**`main` is protected, so the bump cannot be pushed directly.** This is the step people try to skip.

1. **Stay on the branch you are on.** Never `git switch -c` a release branch locally: the remote
   name is `/pull-request`'s job (its Step 1.5), and it pushes with `git push origin HEAD:<name>`.
   v1.2.0 created `release/v1.2.0-vc17-b19` locally, then needed a switch back and a
   `git merge --ff-only`, which stopped for a permission prompt mid-release.
2. Edit only the counter for the platform being released: `android.versionCode` for Android,
   `ios.buildNumber` for iOS. Bumping both when releasing one spends a number for nothing, and the
   two are independent. **The default is to release both platforms together** so the stores never
   drift a version apart, and then both counters move in this one PR.
3. `/pull-request v<major>-<minor>-<patch>-vc<n>-b<n>` (drop `-vc<n>` or `-b<n>` for one platform)
   to open it and drive the checks green. Its Step 1.5 slugs the name to `[a-z0-9-]`, so write the
   version with hyphens, as `v1-3-0`, rather than leave the dots to its slugging. With a
   `chore(release): cut v<version> ...` commit the branch comes out as `chore/v1-3-0-vc18-b20`.
   Releases up to v1.2.0 used a `release/` prefix; nothing keys on it. **Any follow-up after
   the release PR is a second PR on the task:** `/pull-request` Step 1.5.4 and 5b open a fresh PR
   and move the task's stored number, and without that the board resolves the merged release PR. `tests/unit/appConfigBrand.test.ts` guards the field's shape, and the full
   gate including `E2E Tests (Maestro)` still applies.
4. `/merge-pull-request` to land it.

**Never `--admin` past a red check to get a release out.** The gate exists precisely for the build
that is about to reach users.

## Step 4 - Dispatch the build

From `main`, after the bump has landed.

**Android:**

```
gh workflow run build-android.yml --ref main -f profile=production -f artifact=aab -f submit_track=<track>
```

- `submit_track=none` for an artifact-only release.
- **Production is a full release to every user, with no rollout.** A production release is
  `gh workflow run build-android.yml --ref main -f profile=production -f artifact=aab -f submit_track=production`,
  which uploads with `status: completed`. That is a maintainer decision (2026-10-15): the `plan`
  job used to refuse production without `-f rollout=...`, so every release landed as a staged
  rollout and sat partial until someone widened it by hand in the Play Console (v1.1.0 went out
  at 10%), and that was not worth a manual step every time. **The tradeoff was accepted
  knowingly:** a bad build reaches everyone who updates before it is halted, and there is no OTA
  escape hatch (step 8). It can still be halted at 100%; see step 8. `tests/unit/buildWorkflow.test.ts`
  pins production's absence from the refusal.
- **alpha and beta still need `-f rollout=<fraction>`.** The `plan` job refuses either with an
  empty `rollout`; neither track is in use, and the guard costs nothing there. `internal` is exempt.
  A staged production rollout remains possible as a hand-run dispatch with `-f rollout=0.1` (then
  raise the fraction or **Complete rollout** in the Play Console once Sentry stays quiet, or it
  stays partial indefinitely), but `/release` never dispatches one.
- **Rewrite `store/whatsnew/whatsnew-en-US` in the release PR.** Every upload sends it as the
  release's "What's new", because an API release never passes through the Console where notes
  would otherwise be typed. Play caps it at 500 characters, which
  `tests/unit/buildWorkflow.test.ts` checks. It is public text, so confirm it with the user. The
  iOS App Store release sends the same file as the version's What's New (stage 1, one
  `whatsnew-<locale>` file per localization the version has), so there is nothing to paste.
- **Use dispatch, not a `v*` tag.** A tag build produces the AAB but can never submit: the
  `submit-play` job requires `github.event_name == 'workflow_dispatch'`. Tags are for cutting a
  release candidate artifact, not for releasing.
- Production builds all four ABIs deliberately. Do not pass `-f abis=...` to speed it up: Play needs
  every ABI in one bundle to split per device, and an arm64-only bundle cannot be promoted past
  internal.

**iOS:**

```
gh workflow run build-ios.yml --ref main -f target=device -f submit=<none|testflight|appstore>
```

- `submit=appstore` for an App Store release (the default `/release`), `testflight` for
  TestFlight only. `appstore` is a TestFlight upload plus the two App Store stages (Step 5).
- `target=device`, never `simulator`, and never `both` for a release: `simulator` produces nothing
  installable, and `both` just spends a second runner on a check that is not part of the release.
- The upload talks to Apple directly with `xcrun altool`, so **an EAS Submit outage does not block
  this.** If `eas submit` is the thing that failed, this is the workaround, not a parallel attempt at
  the same thing.

Dispatch both back to back; they run in parallel. Measured on v1.2.0 (2026-10-19, both dispatched
at 00:51 UTC): the Android `Build (production)` job took **29 minutes** and `Submit (Google Play)`
1m25s; the iOS `Device (signed .ipa)` job took **17 minutes** (an older note here said 11),
`Submit (TestFlight)` 7.5 minutes including Apple's processing, and `Submit (App Review)` 16
seconds. iOS took 37 minutes from dispatch to WAITING_FOR_REVIEW, about 12 of them spent waiting
for the session to notice a pending gate (8 minutes at the first, 3.5 at the second; Android's one
gate waited 6.7), on ten-minute `gh run watch` loops. That waste is what Step 5's poller removes.

## Step 5 - The approval gates

If a track was named, each submit job pauses on a GitHub Environment with a required reviewer:

- **Android:** one gate, `google-play`, on `Submit (Google Play)`.
- **iOS TestFlight:** one gate, `app-store-connect`, on `Submit (TestFlight)`.
- **iOS App Store:** two gates, both `app-store-connect`, because every job naming a protected
  environment pauses for its own approval. The first is on `Submit (TestFlight)`: upload, then
  stage 1 prepares the version. The second is on `Submit (App Review)`: stage 2 submits it.

**Without the user's permission for this release** (Step 0), tell the user which gate is waiting
in the run page and wait. **Never approve a gate on your own judgment.** Each one is the last thing
between a dispatch and something users receive.

**With it**, approve the gates the permission covers yourself, one command per Bash call:

1. Find the run you dispatched:
   `gh run list --workflow <build-android.yml|build-ios.yml> --branch main --limit 1 --json databaseId,createdAt,status`.
   Check `createdAt` is after your dispatch, so you approve the run you started.
2. Wait until the gate is pending (about 20 to 30 minutes of build first). Run
   `node scripts/waitForReleaseGate.mjs <run id>` in the background, once per run: it only reads,
   and exits with a `GATE ...` line when a gate is pending or `RUN-COMPLETED ...` with every job's
   result when the run ends (a failed build included), so the session is woken once. If auto mode
   refuses it, the `autoMode.allow` waiting rule in `.claude/settings.json` is missing; fall back to
   a foreground `gh run watch <run id> --interval 60 --compact` with the Bash timeout at 600000,
   which serves as a ten-minute wait, then read the gate. Then read it:
   `gh api repos/Kangentic/mobile/actions/runs/<run id>/pending_deployments`. Approve only an entry
   whose `environment.name` is the gate you expect and whose `current_user_can_approve` is `true`.
   Take the environment id from this response every time. Never write one down or commit one.
3. Tell the user, in one line, the run id, the environment name and the run's `createdAt` you are
   about to approve, so the approval is on the record in this conversation and not only in
   GitHub's deployment history.
4. Approve it:
   `gh api -X POST repos/Kangentic/mobile/actions/runs/<run id>/pending_deployments -F "environment_ids[]=<environment id>" -f state=approved -f comment="Approved by /release at the maintainer's instruction"`.

Auto mode pre-approves exactly this call through two `autoMode.allow` entries in
`.claude/settings.json` (added 2026-10-15 at the maintainer's request). Those entries carry the
same limits as this step: this release's permission, this run, these two environments, never a
rejection. The rule is not a permission in itself: without the user's yes for this release, do
not make the call.

The approval call works: it approved all three gates of v1.2.0 on 2026-10-19 (`google-play`
and both `app-store-connect` gates), and auto mode allowed it under the rule above. It relies on
each environment's required reviewer being the maintainer's own account, self-review not being
prevented, and `gh` being signed in as that account. If the call is ever refused, check those
three with `gh api repos/Kangentic/mobile/environments` and `gh api user`, then hand the gate to
the user.

**Between the two iOS App Store gates:** relay stage 1's report from the `Submit (TestFlight)` job.
`gh run view --log` refuses while the run is still waiting at the second gate, so read the
finished job's log through the API instead: take the job id from
`gh run view <run id> --json jobs --jq "[.jobs[] | {name, databaseId}]"`, then
`gh api repos/Kangentic/mobile/actions/jobs/<job id>/logs`, and look for the lines after
`--mode prepare`. The report covers the review notes, the contact details, and the screenshot
count per localization. Remind the user that listing screenshots can be changed in App Store Connect now,
before stage 2. **Do not dispatch another `build-ios.yml -f target=device` run on `main` while the
second gate waits**, and tell the user the same: the workflow's concurrency group cancels an
in-progress run, so a second dispatch cancels the one parked at `Submit (App Review)`. Its prepared version
survives, but stage 2 then has to be re-run or submitted by hand with Add for Review.
- **"Approve all gates":** approve stage 2 once stage 1 is green and its report shows nothing
  missing. If something is missing, stop and tell the user instead; stage 2 would refuse anyway.
- **"Uploads only":** approve `google-play` and the first `app-store-connect` gate, then tell the
  user that `Submit (App Review)` is theirs.

## Step 6 - Verify, do not trust the green

The build job already fails on an unsigned artifact, and the submit job re-verifies what it
downloaded. On top of that:

**Android:** a green `Submit (Google Play)` plus the `android-vc<n>` tag on the remote
(`gh api repos/Kangentic/mobile/git/matching-refs/tags/android-vc<n>`). The tag step runs only
after the upload step has committed the release, so **a present tag proves the release landed.
A missing tag proves nothing**: that step is `continue-on-error`, so read the submit job instead.
With the Play key on hand, `node scripts/checkPlayVersionCode.mjs ... --version-code <the code just
released>` must now **fail** with "already released on the <track> track"; if it still reports the
code as free, the upload did not land.

**iOS:** usually nothing to do by hand. `build-ios.yml`'s submit job already runs
`checkAppStoreBuild.mjs --await-processing`, which blocks until Apple reaches a terminal state and
fails the job if the build was rejected, and it skips its "verdict was not checked" warning only
when that ran. A green `Submit (TestFlight)` with that warning skipped means Apple **accepted** the
build, which is stronger evidence than any counter re-check. Proven on v0.2.0 build 4, 2026-07-28.
The `ios-b<n>` tag on the remote follows the same rule as Android's: present means accepted, absent
means read the job.

If you do re-check by hand, `node scripts/checkAppStoreBuild.mjs ... --build-number <the number just
released>` must now **fail** saying the build already exists. Apple's processing takes 5 to 30
minutes, so a first check can legitimately still report it free; re-check rather than concluding the
upload failed.

**iOS App Store:** a green `Submit (App Review)` means the review submission read
`WAITING_FOR_REVIEW` or `IN_REVIEW`, or that a re-run found the version already submitted or
approved with this build. The job fails on anything else, so its green is the evidence. Once Apple
approves the version, it goes live to every user on its own. There is nothing left to press, and
no phased release to finish.

Then report the artifact name, version, build counter, and track to the user.

**If the upload failed but the build succeeded, do not rebuild.** Re-run the submit job alone from
the run page. The verified artifact is attached to the run, so a retry costs nothing and does not
need a new build number.

## Step 7 - Record it

- Note the release on the Kangentic task if one is in flight (`kangentic_get_current_task`).
- If anything about the flow changed, update the release and deployment-track sections in
  `docs/developer-guide.md`. `.claude/rules/docs-stay-in-sync.md` applies.

## Step 8 - If the release is bad

Know this before shipping, not while panicking. **Neither store lets you delete a
release that users already have.** The only real lever is stopping further spread and
pushing a fix forward.

**Android:**

1. **Halt the release.** Play Console -> the track -> **Releases** -> **Manage rollout** ->
   **Halt rollout**. This works on a full release at 100% too, not only on a staged one: it
   was offered on v1.1.0 at 100% on 2026-10-15, and Google documents it. Halting stops new
   installs and updates of that version and serves the previous version to new users. Two
   limits: whoever already updated keeps the bad build, and a first release on a track has
   nothing to fall back to. (An earlier version of this step said a `completed` release cannot
   be halted. That was wrong.)
2. **Ship a higher versionCode.** Bump, rebuild, release. This is the only fix for the users
   who already updated.
3. **Do not** attempt to re-upload the same versionCode. Play rejects it, and
   `scripts/checkPlayVersionCode.mjs` fails first.

**iOS:**

1. **Expire the build** in TestFlight, or stop distributing it to the group. Testers
   who already installed keep it.
2. **For an App Store release**, before Apple approves it, **Remove from Review** in App
   Store Connect stops it and returns the version to a draft. After approval it is live for
   every user at once, because `submit=appstore` releases automatically with no phased
   release, so there is nothing to pause. Remove it from sale, or submit an expedited
   review for the fix.
3. **Bump `ios.buildNumber`** and rebuild. The previous number is spent forever.

**Either platform, and this is the one people forget:** a JS-only bug in an app with
`expo-updates` could be fixed over the air without a store round trip. This project
does **not** have `expo-updates` installed, so there is no OTA escape hatch. Every
fix is a full build and a store submission. Do not promise a fast rollback that does
not exist.

## Things that have already gone wrong here

Kept because each cost real time:

- **A "green" build can produce a worthless artifact.** Both workflows verify their output rather
  than trusting exit codes: `jarsigner` exits **non-zero on benign warnings** for a correctly signed
  AAB *and* **zero on a completely unsigned jar**, and `jarsigner` calls a valid APK "unsigned"
  because modern AGP uses v2/v3 schemes with no v1 signature. Never judge signing by an exit code.
- **The first upload for a new package had to be manual**, through the Play Console UI. That is now
  done (versionCode 1, 2026-07-26). Left here because it will apply again for any new package name.
- **The Play API path was NOT proven by that manual upload, and this file used to claim it was.**
  versionCode 1 went up through the Console UI, so nothing had ever exercised the service account's
  write path. The first real API release (v0.2.0, 2026-07-28) uploaded the AAB fine and then failed
  on `Committing the Edit` with `The caller does not have permission`. Uploading a bundle and
  committing a release are different permissions, and `play-publisher@kangentic-mobile` had the
  first but not the second. Fix in Play Console under Users and permissions: give the service
  account app-level access to `com.kangentic.mobile` including **Releases -> Release to testing
  tracks**. Read-only "View app information" is not enough.
- **A failed commit does not spend the versionCode.** After that failure
  `scripts/checkPlayVersionCode.mjs` still reported code 2 free, because an edit that never
  commits never registers the bundle. So the retry is the same versionCode, and re-running the
  `submit-play` job alone is correct: do not rebuild and do not bump.
- **Play App Signing is chosen at first upload and is effectively permanent.** Already enrolled:
  Play holds the app signing key, `kangentic-upload.jks` is the upload key.
- **Only the upload keystore is unrecoverable.** GitHub secrets are write-only, so they are not a
  backup. Losing it means a Play support keystore-reset round trip.
- **An xcodebuild exit code proves even less than a Gradle one.** The first iOS workflow "succeeded"
  in three minutes by building a CocoaPods scheme, because `xcodebuild -list` returns schemes
  alphabetically and the code took `schemes[0]`. Never judge an iOS build by its exit code either.
- **`eas submit` can fail while Apple is healthy.** On 2026-07-26 EAS Build was operational and EAS
  Submit degraded, so the break was in Expo's submit layer. `build-ios.yml` uploads directly with
  `xcrun altool` and is unaffected. Check https://status.expo.dev/ and
  https://developer.apple.com/system-status/ separately; they fail independently.
- **An App Store Connect API key cannot be minted during an ASC incident**, because creating one
  needs the Users and Access page that is down. That is why the upload also accepts an Apple ID plus
  an app-specific password from appleid.apple.com, a different service.
- **A missing GitHub Environment is silently created with no protection rules.** Deleting
  `google-play` or `app-store-connect` does not break a dispatch, it removes the approval gate
  without a single error. Check before releasing.
