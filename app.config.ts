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

const config: ExpoConfig = {
  name: 'Kangentic',
  slug: 'mobile',
  owner: 'kangentic',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: ['kangentic-pair', 'kangentic'],
  userInterfaceStyle: 'dark',
  icon: './assets/brand/icon.png',
  // Root view color behind the React tree, matching the theme background.
  backgroundColor: BRAND_BACKGROUND_COLOR,
  ios: {
    bundleIdentifier: 'com.kangentic.mobile',
    supportsTablet: false,
    // Hand-bumped, like android.versionCode below; see the iOS without a Mac
    // section of docs/developer-guide.md. Required because
    // cli.appVersionSource is "local", which is CLI-wide and not Android-only.
    //
    // Builds 1 and 2 are both spent (2026-07-26). Both uploaded successfully and
    // were then REJECTED in processing for ITMS-90683, and a rejected build number
    // is consumed just as a released one is: Apple requires the next upload to use
    // a higher number. Hence 3.
    buildNumber: '3',
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
  },
  android: {
    package: 'com.kangentic.mobile',
    // Hand-bumped, code-reviewed version code (cli.appVersionSource: "local"
    // in eas.json, so EAS does not track it server-side). Read the Android
    // release section of docs/developer-guide.md before bumping.
    //
    // Version code 1 was released to the Play internal track on 2026-07-26 and
    // is spent. scripts/checkPlayVersionCode.mjs would catch a duplicate before
    // the upload, but leaving a spent value here means every build produces an
    // artifact that cannot be submitted.
    versionCode: 2,
    adaptiveIcon: {
      foregroundImage: './assets/brand/adaptive-icon-foreground.png',
      backgroundImage: './assets/brand/adaptive-icon-background.png',
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
        // The small status-bar icon must be a white-on-transparent asset;
        // the adaptive foreground doubles as a serviceable v1 (the OS masks
        // and tints it). Revisit with a dedicated mono glyph later.
        icon: './assets/brand/adaptive-icon-foreground.png',
        color: BRAND_BACKGROUND_COLOR,
      },
    ],
    [
      'expo-build-properties',
      {
        android: {
          // Notifee ships its core AAR inside the npm package; this is its
          // documented Expo integration (no hand-edited android/, per CNG).
          extraMavenRepos: ['../../node_modules/@notifee/react-native/android/libs'],
        },
      },
    ],
    './plugins/withAndroidPushService.ts',
    // Inert unless the KANGENTIC_IOS_* signing variables are set, which only
    // .github/workflows/build-ios.yml does. See the plugin for why signing has
    // to be scoped to the app target instead of passed to xcodebuild.
    './plugins/withIosManualSigning.ts',
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
