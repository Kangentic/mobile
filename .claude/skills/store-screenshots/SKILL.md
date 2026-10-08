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
npm run dev:shots
```

`dev:shots` is `dev:mock` plus `EXPO_PUBLIC_KANGENTIC_SHOTS=1`, which silences
LogBox in the served bundle so a warning banner cannot land in a listing image.
The iOS job has always set that flag; Android went without it until it was
added here, which left the Play captures one warning away from shipping a
yellow banner nothing downstream would have caught.

Use plain `npm run dev:mock` for ordinary UI work: warnings are HIDDEN under
`dev:shots`, which is right for a capture and wrong for iterating. Both flip a
bundle-time constant, so the rig forces a clean Metro cache when you switch
between them.

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
- a horizontal scrollbar along the bottom of the phone's file-diff frame, caught
  before Android faded it out (the diff is wider than a phone). Twice in a row on
  2026-10-08, and the 7-inch board flashed its vertical thumb the same day, so
  the flow now waits out the fade before `06-file-diff` and `05-board`; if a
  strip ever comes back, raise that wait rather than hiding the app's indicator
- status badges floating 12pt above the row they label
- **a completely BLANK terminal**, on one run out of two

None of those failed anything. **These are product claims, not test output.**

**The blank terminal is the one to know about, because it is intermittent and
invisible to every check.** xterm paints into a canvas inside the WebView, so
nothing it draws reaches the native hierarchy: `terminal-webview is visible`
passes whether the pane is full or empty, and Metro logged
`[terminal] renderer for mock-session-1: webgl` with no error on the run that
came out blank. The next run of the identical commit rendered perfectly.

File size is the cheap tell, and worth checking before you even open the
frames. A full 6.9-inch terminal frame is ~380KB (the 210x48 fixture,
2026-10; it was ~317KB with the old 44x38 one); the blank one was 104KB,
while every other frame in the same run was within noise. If
`02-session-terminal` comes back dramatically smaller than its neighbours,
look at it before doing anything else, and just re-run - it is a WebGL context
loss on the simulator, which is why the terminal page carries retry logic
(scripts/xterm-page/webglRenderer.js).

## Step 6 - Commit all four shelves together

Then run `npm run typecheck`, `npm run lint`, and any test you touched.

Do not open a PR unless asked; the board's Testing column owns that.

## Traps worth knowing before they cost you a run

- **The terminal's visible columns belong to the SHELF, not the grid.** The
  mirror draws every grid of 48 rows or fewer in one reference cell, the cell
  at which 210x48 fills the pane HEIGHT, so the iPhone shows 69 columns, the
  7-inch 77, the 10-inch 80 and the Android phone 90, whatever the mock
  reports. A grid with fewer rows or columns leaves background below and to the
  right (the 44x38 capture filled 49-64% of the width by shelf and 79% of the
  height, and nothing failed). The fixture is
  therefore recorded at 66x48 and widened to 210x48, and any text past column
  69 is cut on iOS only. `tests/unit/storeScreenshots.test.ts` enforces both;
  the numbers are in `src/connection/mockDesktop.ts` above `activeCapture()`.
- **`- back` is not one gesture.** Android has a button, iOS gets an edge swipe
  that is ambiguous over the session screen's three-page pager. The flow taps
  the native bar button (`resource-id: BackButton`) where it exists.
- **A segment tap can dispatch and do nothing.** Maestro reports COMPLETED, the
  pager never turns, and `retryIfNoChange` is false. All three segment taps are
  guarded on their destination and re-tapped.
- **The flow taps the row only after the tick-20 prompt has moved it, and never
  scrolls to it.** The prompt moves the target row from Active to the top of
  Idle, where it stays, so the flow waits for the "Approve:" teaser (it exists
  only once the prompt is pending) and taps the row by id. Do not put a
  `scrollUntilVisible` back here: once the prompt had landed it never matched a
  feed row in any configuration tried on 2026-10-08, on either platform, with
  the target fully on screen, which cost a whole iOS run with zero frames. The
  cause is unknown (it is NOT `centerElement`; an uncentred run failed too), so
  treat it as a property of this feed, not a tuning problem.
- **The session therefore opens on Chat** (a prompt-pending row carries
  `mode=chat`), but the flow still pages to Chat itself, guarded, as the safety
  net for an open that lands elsewhere. Do not "fix" a Terminal landing by
  making a pending prompt switch lenses: the app is right to stay put.
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
