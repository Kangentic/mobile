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
const PREFERRED_SESSION_LENS_STORAGE_KEY = 'settings.preferredSessionLensByTaskId';

/** The remembered per-task lens is capped so the map cannot grow unboundedly. */
const PREFERRED_SESSION_LENS_CAP = 50;

/** The lenses a task remembers: Changes is a destination, not a preference. */
export type PreferredSessionLens = 'terminal' | 'chat';

function parsePreferredLensMap(raw: string | null): Record<string, PreferredSessionLens> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const lensMap: Record<string, PreferredSessionLens> = {};
    for (const [taskId, lens] of Object.entries(parsed)) {
      if (lens === 'terminal' || lens === 'chat') lensMap[taskId] = lens;
    }
    return lensMap;
  } catch {
    return {};
  }
}

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
  /** Last lens the user chose per task (terminal is the unset default). */
  preferredSessionLensByTaskId: Record<string, PreferredSessionLens>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDictationMode: (mode: DictationMode) => Promise<void>;
  markSessionModeHintSeen: () => Promise<void>;
  setHapticsEnabled: (enabled: boolean) => Promise<void>;
  setBackgroundNotificationsMode: (mode: BackgroundNotificationsMode) => Promise<void>;
  setPreferredSessionLens: (taskId: string, lens: PreferredSessionLens) => Promise<void>;
}

/**
 * User preferences. Persisted via expo-secure-store: none of this is a
 * secret, but AsyncStorage is banned in src/state/** (secure-storage.md)
 * and secure-store is already the app's only storage dependency. Values
 * are plain strings, never keys.
 */
export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  dictationMode: 'auto-send',
  hasSeenSessionModeHint: false,
  hapticsEnabled: true,
  backgroundNotificationsMode: 'foreground-service',
  preferredSessionLensByTaskId: {},
  hydrated: false,

  hydrate: async () => {
    const [storedDictationMode, storedModeHintSeen, storedHapticsEnabled, storedBackgroundMode, storedLensMap] =
      await Promise.all([
        SecureStore.getItemAsync(DICTATION_MODE_STORAGE_KEY),
        SecureStore.getItemAsync(SESSION_MODE_HINT_STORAGE_KEY),
        SecureStore.getItemAsync(HAPTICS_ENABLED_STORAGE_KEY),
        SecureStore.getItemAsync(BACKGROUND_NOTIFICATIONS_MODE_STORAGE_KEY),
        SecureStore.getItemAsync(PREFERRED_SESSION_LENS_STORAGE_KEY),
      ]);
    set({
      dictationMode: isDictationMode(storedDictationMode) ? storedDictationMode : 'auto-send',
      hasSeenSessionModeHint: storedModeHintSeen === 'true',
      hapticsEnabled: storedHapticsEnabled !== 'false',
      backgroundNotificationsMode: isBackgroundNotificationsMode(storedBackgroundMode)
        ? storedBackgroundMode
        : 'foreground-service',
      preferredSessionLensByTaskId: parsePreferredLensMap(storedLensMap),
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

  setPreferredSessionLens: async (taskId, lens) => {
    const previousMap = get().preferredSessionLensByTaskId;
    if (previousMap[taskId] === lens) return;
    // Re-inserting on every write keeps insertion order = recency, so the
    // cap always evicts the LEAST recently chosen task.
    const nextMap: Record<string, PreferredSessionLens> = { ...previousMap };
    delete nextMap[taskId];
    nextMap[taskId] = lens;
    const taskIds = Object.keys(nextMap);
    for (const staleTaskId of taskIds.slice(0, Math.max(0, taskIds.length - PREFERRED_SESSION_LENS_CAP))) {
      delete nextMap[staleTaskId];
    }
    set({ preferredSessionLensByTaskId: nextMap });
    await SecureStore.setItemAsync(PREFERRED_SESSION_LENS_STORAGE_KEY, JSON.stringify(nextMap));
  },
}));
