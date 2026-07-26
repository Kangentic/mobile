---
description: Cut a release. Bumps the hand-managed versionCode, drives it through the PR gate, dispatches the CI build, and submits to a Play track behind the approval gate. Asks platform and track first, and refuses the paths that are genuinely blocked rather than failing halfway. Not for a plain merge (use /merge-pull-request) or a build with no release (dispatch build-android.yml directly).
allowed-tools: Read, Glob, Grep, Edit, Bash(git:*), Bash(gh:*), Bash(node:*), Bash(npm:*), Bash(npx:*), AskUserQuestion, mcp__kangentic__kangentic_get_current_task
---

# Release

Cut a release of Kangentic Mobile. This sits one rung above `/merge-pull-request`: that lands code
on `main`, this turns `main` into a signed artifact on a store track.

**Usage:** `/release`

## Step 0 - Ask what release this is

Use `AskUserQuestion` for both axes. Do NOT guess.

1. **Platform:** `android` / `ios`
2. **Track:** `internal` / `closed (alpha)` / `open (beta)` / `production` / `artifact only, no submit`

Then check the answer against the table below and **stop with an explanation if it is blocked.**
Refusing precisely is the job here. Half-executing a blocked release and failing at the upload
wastes a 20 minute build and can leave a dangling Play edit.

| Platform + track | State | What unblocks it |
|---|---|---|
| android + artifact only | **Works** | - |
| android + internal | **Works** | - |
| android + closed (alpha) | **Blocked** | Play Console app-content declarations: store listing, content rating, data safety, target audience, ads, privacy policy URL. None are filled in. Text is drafted in `docs/privacy-policy.md` and `docs/store-listing.md`. |
| android + open (beta) | **Blocked** | Same declarations as closed. |
| android + production | **Blocked** | Personal Play account created 2026-07-20, so production access needs a closed test with **12+ testers opted in for 14 continuous days** first. Opt-outs reset the clock. See the deployment-track ladder in `docs/developer-guide.md`. |
| ios + anything | **Blocked** | No Apple Developer Program membership ($99/yr), no signing certificates, no provisioning profiles, no APNs credentials. `build-ios.yml` compiles for the simulator only, unsigned, and produces nothing installable. Task #9 carries this. |

If the user insists on a blocked path after being told, say plainly that it cannot be done and stop.
Do not attempt a workaround.

## Step 1 - Preflight

All of these, and stop on any failure:

- `git status --porcelain` is empty, and the local checkout is on `main` and up to date with
  `origin/main`. A release is cut from `main`, never from a task branch.
- `main`'s own CI is green: `gh run list --workflow ci.yml --branch main --limit 1`.
- The six release secrets exist: `gh secret list` must show `ANDROID_KEYSTORE_BASE64`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`,
  `GOOGLE_SERVICES_JSON`, `PLAY_SERVICE_ACCOUNT_JSON`. Without the keystore the workflow silently
  degrades to a debug-signed APK, which is useless for a release.

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

## Step 2b - Resolve the version code

`android.versionCode` in `app.config.ts` is hand-managed (`cli.appVersionSource` is `"local"`), so
nothing increments it and Play will reject a duplicate. It is a monotonic integer with **no relation
to semver**: it increments on every single upload, including a `none` semver bump.

1. Read the local value from `app.config.ts`.
2. Ask Play what is already spent:
   `node scripts/checkPlayVersionCode.mjs --key <path to play service account json> --package com.kangentic.mobile --version-code <local value>`
   The maintainer's key lives outside the repo; see the credential inventory in
   `docs/developer-guide.md`.
3. The next code is `max(local, highest on any Play track) + 1`. Using local+1 alone is wrong: a
   release can have been cut from another machine.
4. Report both numbers to the user before changing anything.

## Step 3 - Land the bump through the PR gate

**`main` is protected, so the bump cannot be pushed directly.** This is the step people try to skip.

1. Branch: `release/v<version>-vc<newCode>`.
2. Edit `android.versionCode` in `app.config.ts`. Bump `ios.buildNumber` too **only** if this is an
   iOS release, which today it never is.
3. `/pull-request` to open it and drive the checks green. `tests/unit/appConfigBrand.test.ts` guards
   the field's shape, and the full gate including `E2E tests (Maestro)` still applies.
4. `/merge-pull-request` to land it.

**Never `--admin` past a red check to get a release out.** The gate exists precisely for the build
that is about to reach users.

## Step 4 - Dispatch the build

From `main`, after the bump has landed:

```
gh workflow run build-android.yml --ref main -f profile=production -f artifact=aab -f submit_track=<track>
```

- `submit_track=none` for an artifact-only release.
- **Use dispatch, not a `v*` tag.** A tag build produces the AAB but can never submit: the
  `submit-play` job requires `github.event_name == 'workflow_dispatch'`. Tags are for cutting a
  release candidate artifact, not for releasing.
- Production builds all four ABIs deliberately. Do not pass `-f abis=...` to speed it up: Play needs
  every ABI in one bundle to split per device, and an arm64-only bundle cannot be promoted past
  internal.

Watch it with `gh run watch`. Expect roughly 20 to 30 minutes.

## Step 5 - Approve the environment gate

If a track was named, the `submit-play` job pauses on the `google-play` GitHub Environment, which
requires a reviewer. **Tell the user to approve it** in the run page and wait. Do not try to bypass
it; that gate is the last thing standing between a dispatch and a real upload.

## Step 6 - Verify, do not trust the green

The workflow already fails on an unsigned or wrong-ABI artifact, and the submit job re-verifies the
downloaded bundle. On top of that:

1. Confirm Play sees it:
   `node scripts/checkPlayVersionCode.mjs ... --version-code <the code just released>` must now
   **fail** with "already released on the <track> track". If it still reports the code as free, the
   upload did not land.
2. Report the artifact name, version, versionCode, ABIs, and track to the user.

## Step 7 - Record it

- Note the release on the Kangentic task if one is in flight (`kangentic_get_current_task`).
- If anything about the flow changed, update the Android release section and the deployment-track
  ladder in `docs/developer-guide.md`. `.claude/rules/docs-stay-in-sync.md` applies.

## Things that have already gone wrong here

Kept because each cost real time:

- **A "green" build can produce a worthless artifact.** Both workflows verify their output rather
  than trusting exit codes: `jarsigner` exits **non-zero on benign warnings** for a correctly signed
  AAB *and* **zero on a completely unsigned jar**, and `jarsigner` calls a valid APK "unsigned"
  because modern AGP uses v2/v3 schemes with no v1 signature. Never judge signing by an exit code.
- **The first upload for a new package had to be manual**, through the Play Console UI. That is now
  done (versionCode 1, 2026-07-26), and the API path is proven, so this no longer applies. Left here
  because it will apply again for any new package name.
- **Play App Signing is chosen at first upload and is effectively permanent.** Already enrolled:
  Play holds the app signing key, `kangentic-upload.jks` is the upload key.
- **Only the upload keystore is unrecoverable.** GitHub secrets are write-only, so they are not a
  backup. Losing it means a Play support keystore-reset round trip.
