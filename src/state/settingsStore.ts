import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

export type DictationMode = 'auto-send' | 'manual-send' | 'off';
/**
 * Background notification behavior: 'foreground-service' keeps the secure
 * channel alive in the background with instant local alerts (plus remote
 * push as the killed-app backstop); 'push-only' closes the channel on
 * background and relies on remote push alone; 'off' disables both.
 */
export type BackgroundNotificationsMode = 'foreground-service' | 'push-only' | 'off';

const DICTATION_MODE_STORAGE_KEY = 'settings.dictationMode';
const SESSION_MODE_HINT_STORAGE_KEY = 'settings.hasSeenSessionModeHint';
const HAPTICS_ENABLED_STORAGE_KEY = 'settings.hapticsEnabled';
const BACKGROUND_NOTIFICATIONS_MODE_STORAGE_KEY = 'settings.backgroundNotificationsMode';

function isDictationMode(value: string | null): value is DictationMode {
  return value === 'auto-send' || value === 'manual-send' || value === 'off';
}

function isBackgroundNotificationsMode(value: string | null): value is BackgroundNotificationsMode {
  return value === 'foreground-service' || value === 'push-only' || value === 'off';
}

interface SettingsStoreState {
  /** Default: dictation auto-sends on a final result (the locked UX default). */
  dictationMode: DictationMode;
  /** True once the one-time session mode-toggle tooltip has been dismissed. */
  hasSeenSessionModeHint: boolean;
  /** Haptic feedback on meaningful actions (prompt answered, task moved, pairing succeeded). */
  hapticsEnabled: boolean;
  backgroundNotificationsMode: BackgroundNotificationsMode;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDictationMode: (mode: DictationMode) => Promise<void>;
  markSessionModeHintSeen: () => Promise<void>;
  setHapticsEnabled: (enabled: boolean) => Promise<void>;
  setBackgroundNotificationsMode: (mode: BackgroundNotificationsMode) => Promise<void>;
}

/**
 * User preferences. Persisted via expo-secure-store: none of this is a
 * secret, but AsyncStorage is banned in src/state/** (secure-storage.md)
 * and secure-store is already the app's only storage dependency. Values
 * are plain strings, never keys.
 */
export const useSettingsStore = create<SettingsStoreState>((set) => ({
  dictationMode: 'auto-send',
  hasSeenSessionModeHint: false,
  hapticsEnabled: true,
  backgroundNotificationsMode: 'foreground-service',
  hydrated: false,

  hydrate: async () => {
    const [storedDictationMode, storedModeHintSeen, storedHapticsEnabled, storedBackgroundMode] = await Promise.all([
      SecureStore.getItemAsync(DICTATION_MODE_STORAGE_KEY),
      SecureStore.getItemAsync(SESSION_MODE_HINT_STORAGE_KEY),
      SecureStore.getItemAsync(HAPTICS_ENABLED_STORAGE_KEY),
      SecureStore.getItemAsync(BACKGROUND_NOTIFICATIONS_MODE_STORAGE_KEY),
    ]);
    set({
      dictationMode: isDictationMode(storedDictationMode) ? storedDictationMode : 'auto-send',
      hasSeenSessionModeHint: storedModeHintSeen === 'true',
      hapticsEnabled: storedHapticsEnabled !== 'false',
      backgroundNotificationsMode: isBackgroundNotificationsMode(storedBackgroundMode)
        ? storedBackgroundMode
        : 'foreground-service',
      hydrated: true,
    });
  },

  setDictationMode: async (mode) => {
    set({ dictationMode: mode });
    await SecureStore.setItemAsync(DICTATION_MODE_STORAGE_KEY, mode);
  },

  markSessionModeHintSeen: async () => {
    set({ hasSeenSessionModeHint: true });
    await SecureStore.setItemAsync(SESSION_MODE_HINT_STORAGE_KEY, 'true');
  },

  setHapticsEnabled: async (enabled) => {
    set({ hapticsEnabled: enabled });
    await SecureStore.setItemAsync(HAPTICS_ENABLED_STORAGE_KEY, enabled ? 'true' : 'false');
  },

  setBackgroundNotificationsMode: async (mode) => {
    set({ backgroundNotificationsMode: mode });
    await SecureStore.setItemAsync(BACKGROUND_NOTIFICATIONS_MODE_STORAGE_KEY, mode);
  },
}));
