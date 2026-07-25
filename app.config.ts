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
  },
  android: {
    package: 'com.kangentic.mobile',
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
