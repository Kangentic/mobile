---
name: store-screenshots
description: >-
  Re-capture the Play and App Store listing screenshots across all four shelves
  and verify them before they ship. Use whenever the captured screens, the mock
  content, or the tab bar change, or when a listing needs refreshing. It exists
  because the two platforms have wildly different costs (Android is 6 minutes
  local, iOS is 45 minutes of CI per attempt) and because a wrong-but-plausible
  frame passes every automated check there is.
---

# Re-capture the store screenshots

Four shelves, 24 frames, one flow. Android runs locally in minutes; iOS runs on
a macOS runner and costs roughly **45 minutes per attempt**, almost all of it
the Xcode build. That asymmetry drives the whole order below: **dispatch iOS
first, then capture Android while it builds.**

| Shelf | Size | Where | Cost |
|---|---|---|---|
| Play phone | 1080x1920 | local emulator | ~6 min |
| Play 7-inch | 1080x1920 | local emulator | ~6 min |
| Play 10-inch | 1440x2560 | local emulator | ~6 min |
| App Store 6.9-inch iPhone | 1320x2868 | macOS runner | ~45 min |

Background on the shelf geometry, Play's 9:16-on-tablets rule, and the
iOS-specific traps lives in `store/screenshots/README.md`. Read it before
changing anything about the capture itself.

## When a re-capture is actually needed

Only these change a frame. Everything else is churn:

- **Any of the six captured screens** (Agents feed, session terminal / chat /
  changes, file diff, board).
- **The mock content** (`src/connection/mockDesktop.ts`). Mock copy is IN the
  frames, so a rename or a new line means all four shelves drift.
- **The tab bar** (`app/(tabs)/_layout.tsx`). It appears in `01-agents` and
  `05-board` on every shelf.

**Re-capture every shelf, not the one you looked at.** Half a set is worse than
a stale set: the two stores then show visibly different copy for the same app,
and nothing flags it.

## Step 0 - Decide whether the flow itself changed

If you edited `.maestro/screenshots/store-capture.yaml`, **prove it on Android
before spending an iOS run.** A local run is ~6 minutes and exercises every
selector and conditional. Twice, a flow bug cost a full 45-minute iOS cycle and
was reproducible locally for free.

If you only changed app or mock code, skip to step 1.

## Step 1 - Dispatch iOS (do this FIRST)

```
gh workflow run build-ios.yml --ref <branch> -f screenshots=true
gh run list --workflow=build-ios.yml --limit 1 --json databaseId,status,headSha
```

It builds from the pushed branch, so **commit and push first** or you capture
the previous code. Then leave it and do Android.

Concurrency is `cancel-in-progress`, so a second dispatch supersedes the first
automatically. Changing your mind costs nothing.

## Step 2 - Bring up the mock rig

```
npm run dev:mock
```

Wait for BOTH the emulator to appear in `adb devices` AND Metro to log
`Android Bundled`. A capture started before the bundle lands photographs a
loading screen.

**It must be a DEV build.** `isMockDesktopEnabled()` is `__DEV__ && ...`, so a
release APK shows an unpaired "Connecting to your desktop..." screen and the
flow times out on the first selector. Check for the DEBUGGABLE flag if the
screen looks wrong:

```
adb shell "dumpsys package com.kangentic.mobile | grep flags="
```

**If the emulator died but Metro survived** (common between sessions), do NOT
kill anything by name, pid guess, or port. Use the rig's own registry, which
verifies OS identity before stopping anything:

```
npm run dev:stop -- --dry-run    # prints targets, kills nothing
npm run dev:stop
npm run dev:mock
```

A command-line scan once matched the desktop app and killed it, with every
agent session under it. See `.claude/rules/e2e-maestro-runs.md`.

## Step 3 - Capture the three Android shelves

```
node scripts/storeScreenshots.mjs phone
node scripts/storeScreenshots.mjs seven-inch
node scripts/storeScreenshots.mjs ten-inch
```

One at a time, same emulator. The script sets each shelf's resolution and
density, **reads both back**, cleans the status bar, runs the flow, asserts
every PNG is exactly the shelf's required size, and restores the device even
when the flow fails.

`all` does all three. `--serial` picks a device, `--keep-geometry` skips the
restore while iterating, `--dry-run` prints the plan.

## Step 4 - Collect and verify iOS

```
gh run view <id> --json status,conclusion
gh api repos/Kangentic/mobile/actions/runs/<id>/artifacts --jq '.artifacts[] | .name'
gh run download <id> -n ios-store-screenshots-<full-sha> --dir <scratch>
```

The run reports how many frames it captured and **names any expected shot it
did not**. A short set is not a mystery, so read the summary before guessing.

If frames are missing, the failure screenshot is in the
`ios-screenshot-maestro-<sha>` artifact under
`.maestro/tests/<timestamp>/store-capture/screenshots/`. **Read it before
forming a hypothesis** - that rule has paid for itself every single time.

Copy the frames into `store/screenshots/ios/iphone-6.9/`.

## Step 5 - Look at every frame

The script proves the frames are the right SIZE. Nothing proves they are the
right PICTURE, and this is where every real defect has been found:

- a terminal clipped mid-word, on iOS only
- a back button reading `task/[taskId]/index`
- an un-navigated feed shot that a filename collision let through
- a Maestro *failure* frame collected as a listing image
- two wifi icons, from a status bar left in demo mode by an earlier run

None of those failed anything. **These are product claims, not test output.**

## Step 6 - Commit all four shelves together

Then run `npm run typecheck`, `npm run lint`, and any test you touched.

Do not open a PR unless asked; the board's Tests column owns that.

## Traps worth knowing before they cost you a run

- **Mock terminal copy has a 34-column budget**, including indentation. The
  terminal mirror fits its font to screen HEIGHT, so a TALLER phone shows FEWER
  columns: the 6.9-inch iPhone hits the font ceiling at 36-37 columns while a
  1080x1920 Android shows ~53. Android will not reveal an overflow.
  `tests/unit/storeScreenshots.test.ts` enforces the budget.
- **`- back` is not one gesture.** Android has a button, iOS gets an edge swipe
  that is ambiguous over the session screen's three-page pager. The flow taps
  the native bar button (`resource-id: BackButton`) where it exists.
- **A segment tap can dispatch and do nothing.** Maestro reports COMPLETED, the
  pager never turns, and `retryIfNoChange` is false. Both segment taps are
  guarded and re-tapped.
- **The Changes page is attempted, not asserted.** One bad navigation used to
  cost every frame after it. A skipped page is reported by name instead.
- **iOS icon precedence is `sf` > `xcasset` > `src`.** Adding an `sf` back to
  the Board trigger would silently ignore the custom PNG.
- **App Store Connect rejects PNGs with an alpha channel.** The captures have
  none; do not "optimise" them through a tool that adds one.

## What this does NOT produce

The app icon and Play feature graphic ship from `@kangentic/branding` and are
uploaded by hand - see `docs/store-listing.md`. App preview videos are optional
and not produced here.
