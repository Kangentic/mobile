# Store listing screenshots

Raw device captures for the Google Play and App Store listings. Product imagery, not test
output: every file here is a claim about what the app does, so look at each one before
uploading it.

**Run `/store-screenshots`** to regenerate. It sequences all four shelves in the
order that avoids waste (dispatch iOS first, capture Android while it builds),
and carries the traps that have each cost a run.

The commands it drives, if you would rather do it by hand:

```
npm run dev:mock
node scripts/storeScreenshots.mjs all
gh workflow run build-ios.yml -f screenshots=true
```

Single shelf: `node scripts/storeScreenshots.mjs phone` (or `seven-inch`, `ten-inch`).
`--serial <adb serial>` picks the device, `--keep-geometry` skips the restore while iterating,
and `--dry-run` prints the plan without touching a device.

## Why these are tracked here

`scripts/syncBranding.mjs` keeps store-console imagery OUT of the repo on purpose - the Play
feature graphic is deliberately absent from its `PNG_COPIES` table, because it lives in
`@kangentic/branding` and is uploaded by hand. Screenshots are a **deliberate exception**: they
are captures of this app's own screens, so there is no branding package for them to live in, and
a listing needs a stable record of exactly what was uploaded.

The app icon and feature graphic are still NOT here. Upload those from
`node_modules/@kangentic/branding/resources/mobile/` (`android-playstore-512.png`,
`android-feature-graphic-1024x500.png`), per [docs/store-listing.md](../../docs/store-listing.md).

## Layout

```
android/phone/        1080x1920   Play phone shelf
android/seven-inch/   1080x1920   Play 7-inch tablet shelf
android/ten-inch/     1440x2560   Play 10-inch tablet shelf
ios/iphone-6.9/       1320x2868   App Store 6.9-inch iPhone shelf
```

All four shelves carry the same six shots, so the two listings tell one story.

Filenames are numbered because both stores display screenshots in upload order and the upload
tools (fastlane `supply` / `deliver`) sort by filename. The numbering is the display order, not
the order the capture flow visits the screens.

| File | Shows |
|---|---|
| `01-agents` | The Agents feed with a session waiting on approval |
| `02-session-terminal` | The live terminal mirror of the desktop PTY |
| `03-session-chat` | The readable transcript with a permission card |
| `04-session-changes` | The changed files in the agent's worktree |
| `05-board` | The board's Executing column, with live sessions |
| `06-file-diff` | A unified diff for one changed file |

The directory names map onto fastlane's metadata layout
(`fastlane/metadata/android/en-US/images/phoneScreenshots` and its `sevenInch` / `tenInch`
siblings), so adopting `supply` later is a copy step rather than a re-organisation. Fastlane
itself is NOT used to capture: `screengrab` needs an Espresso instrumentation APK and `snapshot`
needs an XCUITest target, and both would have to live inside `android/` or `ios/`, which this
project generates and throws away (see `.claude/rules/expo-cng.md`).

## What the capture guarantees

`scripts/storeScreenshots.mjs` fails rather than producing a subtly wrong batch. It:

- sets the shelf's resolution and density and **reads both back**, because a silently ignored
  `wm size` yields correctly-named captures at the wrong geometry;
- refuses to run while expo-dev-menu's floating **"Tools" button** is enabled, since that
  dev-only overlay sits over the app's top-right corner and lands in every frame;
- pins the status bar to 09:30, full battery, full wifi and no notification icons;
- **asserts every output PNG is exactly the shelf's required size** before declaring success;
- restores the device's own resolution and density afterwards, including when the flow fails.

## Play's constraints, and the one that is not obvious

Play requires **16:9 or 9:16 on all three Android shelves, tablets included**. Real tablets are
not 9:16, so naive tablet captures would need letterboxing. Setting resolution and density
independently avoids that: each shelf above is exactly 9:16, inside its pixel bounds, and lands
on genuine per-form-factor dp geometry (360dp, ~617dp, 720dp), so the tablet captures are
faithful layouts rather than upscaled phone shots.

Per-shelf pixel bounds: phone and 7-inch need each side between 320 and 3840; 10-inch needs each
side between 1080 and 7680. Four or more phone captures at 1080px+ is what makes the listing
eligible for Play's promotional surfaces.

## iOS

All six shots, at Apple's exact 1320x2868. `ios.supportsTablet` is `false` in `app.config.ts`,
so App Store Connect wants one shelf only: **6.9-inch iPhone at 1320x2868, minimum three**.

```
ios/iphone-6.9/       1320x2868   App Store 6.9-inch iPhone shelf
```

It cannot be captured from Windows. The same flow runs on a free macOS runner:

```
gh workflow run build-ios.yml -f screenshots=true
gh run download <run-id> -n ios-store-screenshots-<sha>
```

Budget roughly **45 minutes** per attempt, almost all of it the Xcode build, so batch changes
rather than testing them one at a time. Validate any flow edit against the Android emulator
first (about 6 minutes, no CI) - the flow is shared, and every navigation bug found so far
reproduced there.

### What iOS gets wrong that Android does not

Three things bit here, and all three were invisible on Android:

- **The terminal shows FEWER columns on a bigger phone.** The mirror renders the desktop's real
  120-column grid and pans the overflow, and the font is auto-fitted to the screen HEIGHT, so a
  taller viewport picks a bigger font and fits less across. The 6.9-inch iPhone hits the 20px
  ceiling at 36-37 columns; a 1080x1920 Android phone lands near 11px and shows about 53. Mock
  terminal copy is therefore budgeted to 34 columns including indentation, enforced by
  `tests/unit/storeScreenshots.test.ts`.
- **`- back` is not one gesture.** Android has a real back button; iOS gets a left-edge swipe,
  which is ambiguous over the session screen's three-page pager. The flow taps the native bar
  button (`resource-id: BackButton`) where it exists instead.
- **A segment tap can dispatch and do nothing.** Maestro reports it COMPLETED and the pager
  never turns, with no retry (`retryIfNoChange` is false). Both segment taps are guarded and
  re-tapped.

The run reports any expected shot it did NOT capture, by name. A page the flow cannot reach is
skipped rather than aborting the run, so one bad navigation no longer costs every frame after
it - which it did, twice.
