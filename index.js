import './src/lib/cryptoPolyfills';
import { initializeNotifications } from './src/notifications';
import 'expo-router/entry';

// Bundle-entry scope, outside React: the notifee background event handler
// and the expo-notifications background task must be registered here so
// they exist in headless (killed-app) task launches too. Runs after the
// imports above evaluate but before anything renders.
initializeNotifications();
