import type { ExpoConfig } from 'expo/config';

const config: ExpoConfig = {
  name: 'Kangentic',
  slug: 'mobile',
  version: '0.1.0',
  orientation: 'portrait',
  scheme: ['kangentic-pair', 'kangentic'],
  userInterfaceStyle: 'dark',
  ios: {
    bundleIdentifier: 'com.kangentic.mobile',
    supportsTablet: false,
  },
  android: {
    package: 'com.kangentic.mobile',
  },
  plugins: [
    'expo-router',
    'expo-dev-client',
    'expo-secure-store',
    'expo-font',
    [
      'expo-camera',
      {
        cameraPermission: 'Kangentic uses the camera to scan a desktop pairing QR code.',
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
  extra: {
    eas: {
      // Populated by a one-time maintainer `eas init`; builds fail without it.
      projectId: process.env.EAS_PROJECT_ID ?? '',
    },
  },
};

export default config;
