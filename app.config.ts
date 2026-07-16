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
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-secure-store',
    'expo-font',
    'expo-asset',
    // READY TO UNCOMMENT in the Stage 0 native batch, right after
    // `npx expo install expo-splash-screen` lands in the one dev-client
    // rebuild. It cannot go live earlier: a plugin entry for a not-yet-
    // installed package fails config evaluation (verified with
    // `npx expo config --type public`: PluginError "Failed to resolve plugin
    // for module expo-splash-screen"), which would break `expo start`.
    // [
    //   'expo-splash-screen',
    //   {
    //     image: './assets/brand/splash-icon.png',
    //     imageWidth: 200,
    //     resizeMode: 'contain',
    //     backgroundColor: BRAND_BACKGROUND_COLOR,
    //   },
    // ],
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
