---
description: Cut an Android or iOS release. Bumps the hand-managed versionCode or buildNumber, drives it through the PR gate, dispatches the CI build, and submits to a Play track or TestFlight behind the approval gate. Asks platform and track first, and refuses the paths that are genuinely blocked rather than failing halfway. Not for a plain merge (use /merge-pull-request) or a build with no release (dispatch the build workflow directly).
allowed-tools: Read, Glob, Grep, Edit, Bash(git:*), Bash(gh:*), Bash(node:*), Bash(npm:*), Bash(npx:*), AskUserQuestion, mcp__kangentic__kangentic_get_current_task
---

# Release

Cut a release of Kangentic Mobile. This sits one rung above `/merge-pull-request`: that lands code
on `main`, this turns `main` into a signed artifact on a store track.

**Usage:** `/release`

## Step 0 - Ask what release this is

Use `AskUserQuestion` for both axes. Do NOT guess.

1. **Platform:** `android` / `ios`
2. **Track:** Android: `internal` / `closed (alpha)` / `open (beta)` / `production`. iOS:
   `TestFlight internal` / `TestFlight external` / `App Store`. Either: `artifact only, no submit`.

Then check the answer against the table below and **stop with an explanation if it is blocked.**

**Every row is a claim about external state, so treat it as evidence with an age, not as fact.**
The table is accurate **as of 2026-07-28**. This matters because it has already been wrong twice
in ways that cost real time: it asserted the Play API path was proven when nothing had ever
exercised it, and it listed data safety as unfilled after it had been submitted. When a row
decides whether you refuse a release, say when it was last verified and against what. If a row
can be checked in seconds with a script, check it rather than quoting it.
Refusing precisely is the job here. Half-executing a blocked release and failing at the upload
wastes a 20 minute build and can leave a dangling Play edit.

| Platform + track | State | What unblocks it |
|---|---|---|
| either + artifact only | **Works** | - |
| android + internal | **Works** | - |
| android + closed (alpha) | **Blocked** | Play Console app-content declarations: store listing, content rating, target audience, ads, privacy policy URL. **Data safety is DONE** (submitted 2026-07-28, App functionality + Analytics; see `docs/store-listing.md`), the rest are not. Text is drafted in `docs/privacy-policy.md` and `docs/store-listing.md`. Screenshots are still missing, which blocks the listing itself. |
| android + open (beta) | **Blocked** | Same declarations as closed. |
| android + production | **Blocked** | Personal Play account created 2026-07-20, so production access needs a closed test with **12+ testers opted in for 14 continuous days** first. Opt-outs reset the clock. See the deployment-track ladder in `docs/developer-guide.md`. |
| ios + TestFlight internal | **Works** | Needs `ASC_API_KEY_BASE64` + `ASC_KEY_ID` + `ASC_ISSUER_ID`, or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD`, as GitHub secrets. Check with `gh secret list` before promising it. |
| ios + TestFlight external | **Blocked** | Needs a Beta App Review plus a beta description, feedback email, and test information. None entered. |
| ios + App Store | **Blocked** | Needs screenshots, the privacy questionnaire, an age rating, and a resolved export-compliance answer. `ITSAppUsesNonExemptEncryption` is currently `false` as a reasoned default, not a verified conclusion; see the comment in `app.config.ts`. |

If the user insists on a blocked path after being told, say plainly that it cannot be done and stop.
Do not attempt a workaround.

**One thing to say out loud for any iOS release: the iOS app has never been run.** It compiles and
it signs, but no build has ever launched on a device or simulator. The WKWebView terminal and the
notification stack are untested on the platform, and the Notification Service Extension that iOS
push decryption needs is a later phase. A TestFlight build is worth cutting to find that out, but
do not describe it to the user as a working app.

## Step 1 - Preflight

All of these, and stop on any failure:

- `git status --porcelain` is empty, and the local checkout is on `main` and up to date with
  `origin/main`. A release is cut from `main`, never from a task branch.
- `main`'s own CI is green: `gh run list --workflow ci.yml --branch main --limit 1`.
- The platform's secrets exist (`gh secret list`):
  - **Android:** `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
    `ANDROID_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON`, `PLAY_SERVICE_ACCOUNT_JSON`. Without the keystore
    the workflow silently degrades to a debug-signed APK, which is useless for a release.
  - **iOS:** `IOS_DIST_CERT_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`,
    plus either the `ASC_*` trio or `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` if uploading. A device
    build fails immediately on a missing secret rather than degrading, so this preflight only saves
    time; it is not load bearing.
- The approval environment for the chosen platform still has a required reviewer:
  `gh api repos/Kangentic/mobile/environments --jq '.environments[] | {name, rules: [.protection_rules[].type]}'`
  must show `required_reviewers` on `google-play` (Android) or `app-store-connect` (iOS). **A missing
  environment is silently auto-created with no protection**, which turns the gate into a no-op with
  no error anywhere.

## Step 2a - Ask for the semver bump

`version` in `app.config.ts` is the user-facing version name (`0.1.0` today) and is hand-managed.
Ask with `AskUserQuestion`: **major / minor / patch / none**.

Guidance to give when asking, since the right answer depends on what landed since the last release:

- **patch** - fixes and internal work only, no behaviour a user would notice. The default for a
  routine internal build.
- **minor** - new user-visible capability, backward compatible. The app is pre-1.0, so a minor bump
  is the normal way to mark a real feature landing.
- **major** - reserved. While pre-1.0 there is no compatibility promise to break, so `1.0.0` should
  mean "first public release", not "big change". Do not spend it early.
- **none** - re-releasing the same version with a new build. Legitimate when the previous artifact
  was broken, and the only case where `version` stays put while `versionCode` still must increase.

Two things that are NOT the app version and must not be bumped in sympathy: the
`@kangentic/protocol` package version (published from the desktop repo, see
`.claude/rules/protocol-types-from-package.md`) and `package.json`'s `version`, which is inert for a
`private: true` app that is never published to npm.

## Step 2b - Resolve the build identifier

Both platforms have a hand-managed build counter (`cli.appVersionSource` is `"local"`, which is
CLI-wide and not Android-only), so nothing increments either one and both stores reject a duplicate.
Each is an integer with **no relation to semver**: it increments on every single upload, including a
`none` semver bump.

**Android** - `android.versionCode`:

1. Read the local value from `app.config.ts`.
2. Ask Play what is already spent:
   `node scripts/checkPlayVersionCode.mjs --key <path to play service account json> --package com.kangentic.mobile --version-code <local value>`
3. The next code is `max(local, highest on any Play track) + 1`. Using local+1 alone is wrong: a
   release can have been cut from another machine.

**iOS** - `ios.buildNumber`:

1. Read the local value from `app.config.ts`.
2. Ask App Store Connect:
   `node scripts/checkAppStoreBuild.mjs --key <AuthKey.p8> --key-id <id> --issuer-id <id> --bundle-id com.kangentic.mobile --version <version> --build-number <local value>`
3. Apple requires the build number to be unique **per version string**, not globally increasing, so
   after a semver bump it may legally restart. Do not blindly take the global max.

Either key lives outside the repo; see the credential inventory in `docs/developer-guide.md`. The
workflows run the matching check themselves before building, so this step is about telling the user
the number in advance, not about enforcement.

Report both the local and the store-side numbers before changing anything.

**Read the tags, not the comments.** Every successful submit now records what it spent:
`git tag --list 'android-vc*'` and `git tag --list 'ios-b*'`. Those are written by the submit jobs
after the upload lands (for iOS, after Apple *accepts*), so they cannot drift. The comments in
`app.config.ts` are maintained by hand and are a courtesy, not a source of truth. A stale one is
exactly what sent the 2026-07-28 release at an iOS build number Apple had already taken.

**Three places now catch a spent counter, in increasing cost:**

1. `Release counters (store preflight)` in `ci.yml`, on any PR that changes a counter's value.
   Seconds, and it is where a bad bump should die.
2. The `plan` job in `build-android.yml` and the pre-archive check in `build-ios.yml`. Both run
   before anything expensive.
3. The submit jobs themselves, which re-check to close the window where another machine took the
   number mid-build.

Note that (1) is **not a required status check** unless it has been added to main's branch
protection. Check before relying on it to block a merge.

## Step 3 - Land the bump through the PR gate

**`main` is protected, so the bump cannot be pushed directly.** This is the step people try to skip.

1. Branch: `release/v<version>-<vc|b><newNumber>`.
2. Edit only the counter for the platform being released: `android.versionCode` for Android,
   `ios.buildNumber` for iOS. Bumping both when releasing one spends a number for nothing, and the
   two are independent.
3. `/pull-request` to open it and drive the checks green. `tests/unit/appConfigBrand.test.ts` guards
   the field's shape, and the full gate including `E2E Tests (Maestro)` still applies.
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
- **Add `-f rollout=0.1` for any track with real users.** It releases to 10% with an
  `inProgress` status, which is the only state Play lets you **halt** later. A
  `completed` release cannot be pulled back, only superseded by a higher versionCode.
  Internal testing is small and known enough not to need it; closed, open, and
  production are not. See step 8.
  **This is now enforced, not advisory:** the `plan` job refuses `alpha` or `beta` with an empty
  `rollout` and names the reason. `internal` is deliberately exempt. It was moved out of prose
  because a rule that only exists in a skill file holds right up until somebody is in a hurry,
  and the action it guards is irreversible.
- **Use dispatch, not a `v*` tag.** A tag build produces the AAB but can never submit: the
  `submit-play` job requires `github.event_name == 'workflow_dispatch'`. Tags are for cutting a
  release candidate artifact, not for releasing.
- Production builds all four ABIs deliberately. Do not pass `-f abis=...` to speed it up: Play needs
  every ABI in one bundle to split per device, and an arm64-only bundle cannot be promoted past
  internal.

**iOS:**

```
gh workflow run build-ios.yml --ref main -f target=device -f submit=<none|testflight>
```

- `target=device`, never `simulator`, and never `both` for a release: `simulator` produces nothing
  installable, and `both` just spends a second runner on a check that is not part of the release.
- The upload talks to Apple directly with `xcrun altool`, so **an EAS Submit outage does not block
  this.** If `eas submit` is the thing that failed, this is the workaround, not a parallel attempt at
  the same thing.

Watch either with `gh run watch`. Measured: roughly 20 to 30 minutes for Android, about **11 minutes**
for iOS (the `xcodebuild archive` step is 8.5 of those and everything else is noise).

## Step 5 - Approve the environment gate

If a track was named, the submit job pauses on a GitHub Environment with a required reviewer:
`google-play` for Android, `app-store-connect` for iOS. **Tell the user to approve it** in the run
page and wait. Do not try to bypass it; that gate is the last thing standing between a dispatch and a
real upload.

## Step 6 - Verify, do not trust the green

The build job already fails on an unsigned artifact, and the submit job re-verifies what it
downloaded. On top of that:

**Android:** `node scripts/checkPlayVersionCode.mjs ... --version-code <the code just released>` must
now **fail** with "already released on the <track> track". If it still reports the code as free, the
upload did not land.

**iOS:** usually nothing to do by hand. `build-ios.yml`'s submit job already runs
`checkAppStoreBuild.mjs --await-processing`, which blocks until Apple reaches a terminal state and
fails the job if the build was rejected, and it skips its "verdict was not checked" warning only
when that ran. A green `Submit (TestFlight)` with that warning skipped means Apple **accepted** the
build, which is stronger evidence than any counter re-check. Proven on v0.2.0 build 4, 2026-07-28.

If you do re-check by hand, `node scripts/checkAppStoreBuild.mjs ... --build-number <the number just
released>` must now **fail** saying the build already exists. Apple's processing takes 5 to 30
minutes, so a first check can legitimately still report it free; re-check rather than concluding the
upload failed.

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

1. **Halt the rollout.** Play Console -> the track -> the release -> **Halt rollout**.
   Only possible if the release is a staged rollout (`status: inProgress`), which is
   what `-f rollout=0.1` produces. A `completed` release cannot be halted, only
   superseded. That is the argument for defaulting to a staged rollout on any track
   with real users.
2. **Ship a higher versionCode.** Even after halting, whoever already updated stays
   updated. Bump, rebuild, release.
3. **Do not** attempt to re-upload the same versionCode. Play rejects it, and
   `scripts/checkPlayVersionCode.mjs` fails first.

**iOS:**

1. **Expire the build** in TestFlight, or stop distributing it to the group. Testers
   who already installed keep it.
2. **For an App Store release**, remove it from sale, or submit an expedited review
   for the fix. Apple has phased release for automatic updates, which can be paused
   in App Store Connect, but that only affects users who have not updated yet.
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
