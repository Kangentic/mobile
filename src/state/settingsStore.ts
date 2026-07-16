import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

export type DictationMode = 'auto-send' | 'manual-send' | 'off';

const DICTATION_MODE_STORAGE_KEY = 'settings.dictationMode';
const SESSION_MODE_HINT_STORAGE_KEY = 'settings.hasSeenSessionModeHint';

function isDictationMode(value: string | null): value is DictationMode {
  return value === 'auto-send' || value === 'manual-send' || value === 'off';
}

interface SettingsStoreState {
  /** Default: dictation auto-sends on a final result (the locked UX default). */
  dictationMode: DictationMode;
  /** True once the one-time session mode-toggle tooltip has been dismissed. */
  hasSeenSessionModeHint: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDictationMode: (mode: DictationMode) => Promise<void>;
  markSessionModeHintSeen: () => Promise<void>;
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
  hydrated: false,

  hydrate: async () => {
    const storedDictationMode = await SecureStore.getItemAsync(DICTATION_MODE_STORAGE_KEY);
    const storedModeHintSeen = await SecureStore.getItemAsync(SESSION_MODE_HINT_STORAGE_KEY);
    set({
      dictationMode: isDictationMode(storedDictationMode) ? storedDictationMode : 'auto-send',
      hasSeenSessionModeHint: storedModeHintSeen === 'true',
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
}));
