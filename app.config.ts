import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpoConfig } from 'expo/config';

/**
 * Mirror of darkTerminalTheme.colors.background (src/components/theme/tokens.ts).
 * Inlined because the Expo config loader transpiles only this file, so a
 * relative TS import of the tokens module fails at `expo config` time
 * (verified: "Cannot find module './src/components/theme/tokens'").
 * tests/unit/appConfigBrand.test.ts asserts this stays equal to the token.
 */
const BRAND_BACKGROUND_COLOR = '#0f0d0a';

/**
 * Mirror of brandTokens.rust (src/components/theme/tokens.ts). Same inlining
 * constraint as BRAND_BACKGROUND_COLOR above; tests/unit/appConfigBrand.test.ts
 * asserts this stays equal to the token.
 */
const BRAND_NOTIFICATION_COLOR = '#c0562f';

const config: ExpoConfig = {
  name: 'Kangentic',
  slug: 'mobile',
  owner: 'kangentic',
  version: '0.4.1',
  orientation: 'portrait',
  scheme: ['kangentic-pair', 'kangentic'],
  userInterfaceStyle: 'dark',
  icon: './assets/brand/icon.png',
  // Root view color behind the React tree, matching the theme background.
  backgroundColor: BRAND_BACKGROUND_COLOR,
  ios: {
    bundleIdentifier: 'com.kangentic.mobile',
    supportsTablet: false,
    // All three appearances are explicit because prebuild resolves the base
    // (light) icon as `light || dark || tinted`, falling back to the
    // top-level `icon` string only when the object carries none of the three.
    // A dark-only object would therefore ship the DARK mark as the light
    // icon, silently, rather than inheriting `icon` above.
    icon: {
      light: './assets/brand/icon.png',
      dark: './assets/brand/icon-dark.png',
      tinted: './assets/brand/icon-tinted.png',
    },
    // Hand-bumped, like android.versionCode below; see the iOS without a Mac
    // section of docs/developer-guide.md. Required because
    // cli.appVersionSource is "local", which is CLI-wide and not Android-only.
    //
    // Builds 1 and 2 were uploaded on 2026-07-26 and REJECTED in processing for
    // ITMS-90683. Build 3 was uploaded on 2026-07-27 and is VALID. The previous
    // comment here claimed only 1 and 2 were spent, "hence 3", and was already
    // stale: the 2026-07-28 release run was refused before the archive with
    // "Build number 3 already exists on App Store Connect (state: VALID)".
    //
    // THE GATE IS GLOBAL PER APP, NOT PER VERSION STRING. Apple's own rule
    // scopes CFBundleVersion uniqueness to the marketing version, and the
    // comment in scripts/checkAppStoreBuild.mjs repeats that, but the conflict
    // filter it actually fails on queries every build for the app and never
    // looks at the version. The script is what stops the build, so its rule is
    // the one that governs: bumping `version` does NOT free a used build number.
    // Do not reason from Apple's documented rule here and expect a lower number
    // to pass.
    //
    // Rejected builds never become Build resources, so they are invisible to
    // that check: the 2026-07-27 run logged "Registered builds visible: 0"
    // moments before uploading 3.
    //
    // SPENT: 3 (uploaded 2026-07-27) and 4 (uploaded 2026-07-28 under 0.2.0,
    // and ACCEPTED by Apple, confirmed by the submit job's --await-processing
    // step rather than inferred from a green check). 1 and 2 were rejected in
    // processing and never registered. 5 was the v0.3.0 release cut 2026-08-03
    // and 6 the v0.4.0 release cut 2026-08-07, both confirmed spent by the
    // ios-b5 and ios-b6 tags on the remote. 7 is taken by the v0.4.1 release
    // cut 2026-08-15; the ios-b7 tag written by the submit job is the
    // authoritative record once Apple accepts it.
    //
    // Numbers stay globally increasing across semver bumps (7 follows 6 even
    // though `version` moved 0.4.0 -> 0.4.1), per the global-not-per-version
    // rule above: a semver bump frees nothing.
    buildNumber: '7',
    infoPlist: {
      // US export-compliance declaration. `false` asserts the app uses only
      // EXEMPT encryption, which is what App Store Connect stops asking about.
      //
      // REVISIT BEFORE ANY PUBLIC OR EXTERNAL RELEASE. This is not the usual
      // boilerplate case: the app does not merely use OS-provided TLS, it
      // implements its own Noise KK channel (X25519, ChaCha20-Poly1305,
      // BLAKE2s) via @noble. Those are published standard algorithms rather
      // than proprietary crypto, which is the common basis for treating such an
      // app as exempt, but Apple's own documentation pages did not load when
      // this was set, so the value is a considered default and NOT a verified
      // legal conclusion. It is set now because TestFlight internal testing
      // does not act on it and changing it is a one-line edit plus a rebuild.
      ITSAppUsesNonExemptEncryption: false,
      // Required by Apple even though this app never touches the photo library.
      // Builds 1 and 2 were both REJECTED in post-upload processing with
      // ITMS-90683 for its absence, and the rejection is worth understanding
      // because it is invisible to everything upstream: `altool --validate-app`
      // passed, the upload reported UPLOAD SUCCEEDED, and Apple then refused the
      // binary by email.
      //
      // The cause is a linked symbol, not a feature. Apple scans the binary
      // statically, and `expo-file-system/ios/Legacy/FileSystemHelpers.swift`
      // calls `PHPhotoLibrary.authorizationStatus` in a helper for reading `ph://`
      // URIs. Nothing in src/ uses that path, but expo-file-system is a core
      // transitive dependency and cannot be dropped, so the string is mandatory.
      //
      // Worded truthfully rather than inventing a feature. The OS only ever shows
      // a purpose string when the matching API is actually called, and no code
      // path here calls it, so this text is read by App Review and not by users.
      // The dependency scan that found this also checked for location, contacts,
      // calendar, health, bluetooth, NFC and media-library APIs and found none;
      // camera and speech recognition already have their strings from their config
      // plugins.
      NSPhotoLibraryUsageDescription:
        'Kangentic does not read or write your photos. This declaration is required because a file-access framework the app links references the Photos API.',
    },
    // Declares what Sentry's SDK collects. React Native links sentry-cocoa
    // statically, so Apple does NOT auto-process its manifest the way it
    // would for a dynamically-linked framework - the app must declare this
    // itself (Sentry's own apple-privacy-manifest guidance). This entry
    // MERGES into whatever the Expo template already emits
    // (@expo/config-plugins' withPrivacyInfo), it does not replace it; see
    // the generated ios/Kangentic/PrivacyInfo.xcprivacy artifact CI now
    // uploads (.github/workflows/ci.yml, native-config job).
    //
    // A real native crash payload (task: "verify Sentry crash reporting"),
    // read back through the Sentry MCP, confirmed sentry-android attaches a
    // per-install identifier to an OS-caught crash despite
    // sendDefaultPii: false - see .claude/rules/crash-reporting-scope.md's
    // Known Limitations section. sentry-cocoa was not itself tested (no Mac,
    // no iOS device), but it is the same SDK family with the same
    // documented device.id behavior, so the fourth entry below is declared
    // rather than assumed absent. This list and the App Store Connect / Play
    // declarations in docs/store-listing.md are one consistency requirement;
    // they were updated together.
    //
    // Every type declares Analytics alongside AppFunctionality. That is not
    // belt-and-braces, it is what the Play Data safety form actually accepted
    // (2026-07-28): Play offers no "Diagnostics" PURPOSE at all - Diagnostics is
    // a data TYPE there, next to Crash logs - so crash reporting has to be
    // declared under App functionality plus Analytics. docs/store-listing.md
    // previously prescribed "App functionality / Diagnostics only, not
    // analytics", which named a purpose the form does not offer. Apple
    // cross-checks the App Privacy answers against this generated manifest, so
    // the ASC questionnaire declares the same two purposes and all three
    // surfaces now agree.
    privacyManifests: {
      NSPrivacyCollectedDataTypes: [
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: [
            'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            'NSPrivacyCollectedDataTypePurposeAnalytics',
          ],
        },
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePerformanceData',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: [
            'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            'NSPrivacyCollectedDataTypePurposeAnalytics',
          ],
        },
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeOtherDiagnosticData',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: [
            'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            'NSPrivacyCollectedDataTypePurposeAnalytics',
          ],
        },
        {
          // The per-install identifier confirmed above (contexts.device.id,
          // promoted into user.id on an OS-caught crash). Not your device's
          // hardware ID or an advertising ID - resets on reinstall.
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
          NSPrivacyCollectedDataTypeLinked: false,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: [
            'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            'NSPrivacyCollectedDataTypePurposeAnalytics',
          ],
        },
      ],
      // Required-reason APIs the Sentry SDK calls with no opt-out. Reason
      // codes per Sentry's documented guidance.
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['C617.1'],
        },
      ],
    },
  },
  android: {
    package: 'com.kangentic.mobile',
    // Hand-bumped, code-reviewed version code (cli.appVersionSource: "local"
    // in eas.json, so EAS does not track it server-side). Read the Android
    // release section of docs/developer-guide.md before bumping.
    //
    // SPENT: 1 (internal, 2026-07-26, uploaded by hand through the Console) and
    // 2 (internal, 2026-07-28, the first release the API ever committed).
    // 3 was the v0.3.0 internal release cut 2026-08-03 and 4 the v0.4.0
    // internal release cut 2026-08-07, both confirmed spent by the android-vc3
    // and android-vc4 tags on the remote. 5 is taken by the v0.4.1 internal
    // release cut 2026-08-15; the android-vc5 tag written by the submit job is
    // the authoritative record once the upload lands.
    //
    // Keep this list current on the way OUT of a release, not the way in. The
    // iOS half of this file carried a stale "1 and 2 are spent, hence 3" note
    // into 2026-07-28 and cost a failed release run, because build 3 had in
    // fact already been uploaded. scripts/checkPlayVersionCode.mjs catches a
    // duplicate, but only in the submit job, which is after the ~25 minute
    // build AND after the approval gate.
    versionCode: 5,
    adaptiveIcon: {
      foregroundImage: './assets/brand/adaptive-icon-foreground.png',
      backgroundImage: './assets/brand/adaptive-icon-background.png',
      monochromeImage: './assets/brand/adaptive-icon-monochrome.png',
    },
    // FCM config for remote push, picked up only once the developer drops
    // google-services.json at the repo root (gitignored; see the Firebase
    // section of docs/developer-guide.md). Builds stay green without it -
    // remote push simply stays unverifiable until the file lands.
    ...(existsSync(join(__dirname, 'google-services.json'))
      ? { googleServicesFile: './google-services.json' }
      : {}),
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-secure-store',
    'expo-font',
    'expo-asset',
    // expo-system-ui is what actually applies `userInterfaceStyle` above.
    // Without it prebuild warns "Install expo-system-ui in your project to
    // enable this feature" and the dark-mode declaration is inert.
    'expo-system-ui',
    'expo-status-bar',
    [
      'expo-splash-screen',
      {
        image: './assets/brand/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: BRAND_BACKGROUND_COLOR,
      },
    ],
    [
      'expo-notifications',
      {
        // Generates the `notification_icon` drawable and
        // `notification_icon_color` colour resource. Notifee - what actually
        // displays every notification in this app - ignores this plugin's
        // manifest meta-data and defaults its own smallIcon/color, so
        // src/notifications/channels.ts references these resources by name
        // explicitly at every displayNotification call site.
        icon: './assets/brand/notification-icon.png',
        color: BRAND_NOTIFICATION_COLOR,
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          // Notifee ships its core AAR inside the npm package; this is its
          // documented Expo integration (no hand-edited android/, per CNG).
          extraMavenRepos: ['../../node_modules/@notifee/react-native/android/libs'],
          // R8. Without these two the SDK 57 template defaults both to false, and
          // Play Console rates the bundle "App optimization: Low" with its
          // optimization, shrinking, and R8-configuration rows all empty.
          //
          // These are GRADLE PROPERTIES, not build.gradle edits: the template's
          // release block reads them through findProperty, so anything asserting
          // on this asserts against android/gradle.properties.
          //
          // They therefore apply to every build of the RELEASE variant, which is
          // `preview`, `e2e`, AND `production` - only `development` is debug. So
          // e2e.yml's Maestro suite runs against a minified APK on every PR. That
          // is deliberate: it is the only gate that exercises a stripped build
          // before Play. It also means an R8 stripping bug reddens a required
          // check and reads exactly like an app bug - suspect R8 first, and fix
          // it with extraProguardRules rather than by turning minify back off.
          //
          // Java/Kotlin frames go unreadable without a mapping file, which is why
          // the Sentry plugin below enables its Android Gradle Plugin. JS frames
          // (Hermes source maps) and native frames (debug symbols) are unaffected.
          enableMinifyInReleaseBuilds: true,
          // Requires minify: expo-build-properties throws on shrink-without-minify
          // (the reverse is fine). Resource shrinking is the half with no escape
          // hatch here - a wrongly-dropped resource needs res/raw/keep.xml, which
          // this plugin has no option for, so that fix would mean a config plugin.
          //
          // TWO resources are named by string rather than by reference, not one:
          //
          //   notification_icon - the drawable src/notifications/channels.ts names
          //     explicitly because Notifee ignores the manifest meta-data. SAFE:
          //     the expo-notifications block above also emits a manifest
          //     meta-data entry pointing at it, and manifest-referenced resources
          //     are never shrunk.
          //   xterm.html        - src/components/terminal/TerminalPane.tsx does
          //     `require('../../terminal/xterm.html')`. Metro files every
          //     non-drawable asset under res/raw (see @react-native/assets-registry
          //     path-support.js: .html is not in drawableFileTypes), and the name
          //     is resolved from the JS bundle at runtime, which the shrinker
          //     never scans. NOT anchored by anything - it depends on aapt2's
          //     safe-mode heuristic being conservative about res/raw.
          //
          // The second one is the Terminal pane, which is the DEFAULT view of the
          // session screen, and no Maestro flow asserts WebView content
          // (.maestro/paired/session-mode-toggle.yaml says so in its header).
          //
          // GUARDED NOW, which is what makes this flag defensible rather than a
          // bet. .github/scripts/verify-android-assets.sh runs in e2e.yml and
          // build-android.yml and fails the build unless the artifact still
          // carries an html resource the size of src/terminal/xterm.html. It
          // matches on SIZE because the path is not stable: the APK renames it
          // to res/JU.html while the AAB keeps
          // base/res/raw/src_terminal_xterm.html (both verified against real
          // artifacts, runs 30506459459 and 30466715863).
          //
          // KNOW WHAT THAT DOES NOT COVER. On the production path the guard
          // proves the AAB CI produced, not the split APK a device installs:
          // Play re-runs its own resource optimization at split time, which is
          // the same reason the AAB still carries the un-renamed name above. No
          // check in this repository runs after that. Closing it would mean
          // `bundletool build-apks` against a real production bundle.
          //
          // A THIRD string-named resource exists and is deliberately not in the
          // list above: assets/brand/kanban-tab.png, require()d for the Board
          // tab icon (synced from @kangentic/branding; it was
          // assets/tab-icons/board-kanban.png until this repo stopped
          // rasterising its own). It is unanchored in exactly the same way, but
          // Android resolves `drawable > md > src` and the trigger sets
          // md="view_kanban", so Android never reads the PNG at all. It is
          // protected by inaction rather than by anchoring. Dropping that `md`
          // would quietly move it into the same hazard class as xterm.html.
          //
          // AND IT COSTS NOTHING TO KEEP. Turning it off was measured on
          // 2026-07-30, one run per arm, normalising each build against
          // buildCMakeRelWithDebInfo + minifyReleaseWithR8 because those are
          // identical work in both arms and the runner-to-runner spread on them
          // is enormous (174.5s to 252.3s across four runs of the same code):
          //
          //   shrink ON  (run 30517281178)  536s total, 252.3s anchor, ratio 2.12
          //   shrink OFF (run 30517932999)  534s total, 244.1s anchor, ratio 2.19
          //
          // Shrinking off was very slightly WORSE, so its cost is below the
          // noise floor. The ~166s that `minifyReleaseWithR8` adds to a release
          // build is CODE shrinking, not resource shrinking, and AGP 8 fuses
          // both into that one task - which is why no log can split them and the
          // experiment had to be run. Do not repeat it expecting minutes.
          enableShrinkResourcesInReleaseBuilds: true,
          // E2E BUILDS ONLY. Android blocks cleartext traffic in a
          // release-shaped build, so the dev relay's ws:// socket is refused
          // by the platform before any of our code runs - the pairing screen
          // just reports "Relay connection closed before it opened (code
          // 1006)". The dev client never hits this because its debug
          // network-security-config permits cleartext.
          //
          // Gated on the same build-time flag as the relay-address carve-out
          // in src/pairing/qr.ts, so it travels with the `e2e` profile and
          // cannot reach `preview` or `production`: EXPO_PUBLIC_* values are
          // read here at config-evaluation time, and the e2e profile is the
          // only one in eas.json that sets it.
          ...(process.env.EXPO_PUBLIC_KANGENTIC_E2E === '1' ? { usesCleartextTraffic: true } : {}),
        },
      },
    ],
    './plugins/withAndroidPushService.ts',
    // Inert unless EXPO_PUBLIC_KANGENTIC_E2E=1, which only the `e2e` build
    // profile sets. Disables GWP-ASan for the E2E APK: the sampling allocator
    // crashed the app 838ms after launch on a CI emulator, inside its own
    // backtrace bookkeeping on a Hermes fcontext stack. See the plugin.
    './plugins/withAndroidE2eGwpAsanOff.ts',
    // Always writes its block into android/settings.gradle; the block itself
    // no-ops on anything but Windows. Relocates each module's CMake staging
    // directory to a short absolute root so a local Android build works from
    // any checkout depth. Gating in Groovy rather than here keeps prebuild output
    // identical on every platform, so ci.yml can verify the block landed. See
    // the plugin for both MAX_PATH mechanisms.
    './plugins/withAndroidCmakeBuildStaging.ts',
    // Replaces the template's 2048m org.gradle.jvmargs: R8 (enabled above via
    // enableMinifyInReleaseBuilds) OOMed the daemon on the first four-ABI
    // production build, taking the concurrent CMake configure down with it.
    // See the plugin for why this is project config, not a CI env var.
    './plugins/withAndroidGradleHeap.ts',
    // Inert unless the KANGENTIC_IOS_* signing variables are set, which only
    // .github/workflows/build-ios.yml does. See the plugin for why signing has
    // to be scoped to the app target instead of passed to xcodebuild.
    './plugins/withIosManualSigning.ts',
    // Injects a collision-safe UUID generator at the top of the Podfile's
    // post_install hook. Without it, CocoaPods' sequential UUID counter can
    // hand an SPM object the Pods project root object's own UUID, which saves
    // a Pods.xcodeproj with no PBXProject that xcodebuild rejects as damaged.
    // Upstream bug, input-shape dependent; see the plugin for the evidence.
    './plugins/withIosPodsUuidCollisionGuard.ts',
    // Source-map + debug-symbol upload only, gated on SENTRY_AUTH_TOKEN. The
    // plugin entry is omitted entirely rather than passed empty options: an
    // absent auth token must not make the plugin run and fail (or silently
    // no-op) inside ci.yml's Native config (prebuild) job, which
    // prebuilds both platforms with zero secrets. Crash reporting itself is
    // gated separately (EXPO_PUBLIC_SENTRY_DSN, read at runtime in
    // src/observability/crashReporting.ts) - this only controls whether a
    // build uploads symbols, see docs/security.md.
    ...(process.env.SENTRY_AUTH_TOKEN
      ? ([
          [
            '@sentry/react-native/expo',
            {
              organization: 'kangentic',
              project: 'react-native',
              // R8 (enabled in the expo-build-properties block above) renames the
              // Java/Kotlin layer, so the ProGuard mapping has to reach Sentry or
              // every Android frame below the JS bridge arrives as a.b.c(). This
              // is the ONLY thing that turns the Gradle-plugin half on: without
              // enableAndroidGradlePlugin the mapping-upload path never runs.
              // Scope the damage correctly - JS frames come from Hermes source
              // maps and native frames from debug symbols, both already handled
              // by separate paths, and neither is touched by R8.
              //
              // includeProguardMapping and autoUploadProguardMapping both default
              // to true, so the mapping path needs no explicit flags.
              experimental_android: {
                enableAndroidGradlePlugin: true,
                // Mapping only. The defaults would ALSO start uploading every RN
                // .so debug symbol on each dispatch build - a new behaviour, a
                // large upload, and not what this change is for. Flip these on
                // deliberately if Android native symbolication is ever wanted.
                uploadNativeSymbols: false,
                autoUploadNativeSymbols: false,
              },
            },
          ],
        ] satisfies NonNullable<ExpoConfig['plugins']>)
      : []),
    [
      'expo-camera',
      {
        cameraPermission: 'Kangentic uses the camera to scan a desktop pairing QR code.',
      },
    ],
    [
      'expo-speech-recognition',
      {
        microphonePermission: 'Kangentic uses the microphone to dictate messages to your agent.',
        speechRecognitionPermission: 'Kangentic uses speech recognition to turn your dictation into text.',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: {
      // Created by `eas init` under the kangentic org; override via EAS_PROJECT_ID if needed.
      projectId: process.env.EAS_PROJECT_ID ?? '68840f02-bfa6-41a1-a5bf-386f65d41f83',
    },
  },
};

export default config;
