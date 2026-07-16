import { AndroidConfig, withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins';

/**
 * Android manifest additions for the notification stack (CNG: never
 * hand-edit android/):
 * - POST_NOTIFICATIONS (Android 13+ runtime permission; requested in-app)
 * - FOREGROUND_SERVICE + FOREGROUND_SERVICE_DATA_SYNC (the background
 *   "stay connected" service that keeps the secure channel alive)
 * - foregroundServiceType="dataSync" on notifee's foreground service
 *   (mandatory on Android 14+: an FGS must declare its type or crash at
 *   startForeground time)
 */
const PUSH_PERMISSIONS = [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
];

const NOTIFEE_FOREGROUND_SERVICE = 'app.notifee.core.ForegroundService';

const withAndroidPushService: ConfigPlugin = (config) => {
  return withAndroidManifest(config, (manifestConfig) => {
    const androidManifest = manifestConfig.modResults;

    for (const permission of PUSH_PERMISSIONS) {
      AndroidConfig.Permissions.addPermission(androidManifest, permission);
    }

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
    const services = application.service ?? [];
    const existingService = services.find(
      (service) => service.$?.['android:name'] === NOTIFEE_FOREGROUND_SERVICE,
    );
    if (existingService) {
      existingService.$['android:foregroundServiceType'] = 'dataSync';
    } else {
      services.push({
        $: {
          'android:name': NOTIFEE_FOREGROUND_SERVICE,
          'android:foregroundServiceType': 'dataSync',
        },
      });
    }
    application.service = services;

    return manifestConfig;
  });
};

export default withAndroidPushService;
