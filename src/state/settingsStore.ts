import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

export type DictationMode = 'auto-send' | 'manual-send' | 'off';

const DICTATION_MODE_STORAGE_KEY = 'settings.dictationMode';

function isDictationMode(value: string | null): value is DictationMode {
  return value === 'auto-send' || value === 'manual-send' || value === 'off';
}

interface SettingsStoreState {
  /** Default: dictation auto-sends on a final result (the locked UX default). */
  dictationMode: DictationMode;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDictationMode: (mode: DictationMode) => Promise<void>;
}

/**
 * User preferences. Persisted via expo-secure-store: none of this is a
 * secret, but AsyncStorage is banned in src/state/** (secure-storage.md)
 * and secure-store is already the app's only storage dependency. Values
 * are plain strings, never keys.
 */
export const useSettingsStore = create<SettingsStoreState>((set) => ({
  dictationMode: 'auto-send',
  hydrated: false,

  hydrate: async () => {
    const storedDictationMode = await SecureStore.getItemAsync(DICTATION_MODE_STORAGE_KEY);
    set({
      dictationMode: isDictationMode(storedDictationMode) ? storedDictationMode : 'auto-send',
      hydrated: true,
    });
  },

  setDictationMode: async (mode) => {
    set({ dictationMode: mode });
    await SecureStore.setItemAsync(DICTATION_MODE_STORAGE_KEY, mode);
  },
}));
