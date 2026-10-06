import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { PUSH_CATEGORIES, type PushCategory } from '@kangentic/protocol';

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
// 'settings.terminalFitFontPx' held a remembered terminal cell size until
// 2026-10. The mirror now renders every grid in one reference cell the page
// computes on its own (scripts/xterm-page/state.js), so nothing reads or
// writes it; a value already stored is left in place as dead data, like the
// v1 push-category key below.
/**
 * v2 because the DEFAULT for one category changed (spawn-stalled went off), and
 * a default change alone could not reach the installs that needed it:
 * setPushCategoryEnabled persists the WHOLE map, so anyone who had ever toggled
 * anything carried an explicit `"spawn-stalled": true` that overrode any new
 * default. Reading v1 under the v2 rules is the migration - see
 * parsePushCategoriesEnabled.
 */
const PUSH_CATEGORIES_ENABLED_STORAGE_KEY = 'settings.pushCategoriesEnabled.v2';
/** Read-only now; the v2 key is the only one written. Left in place as dead data. */
const PUSH_CATEGORIES_ENABLED_LEGACY_STORAGE_KEY = 'settings.pushCategoriesEnabled';
const COLLAPSED_TRIAGE_SECTIONS_STORAGE_KEY = 'settings.collapsedTriageSections';
/** Read-only now: the one-collapsed-section value the list replaced. Left in place as dead data. */
const COLLAPSED_TRIAGE_SECTION_LEGACY_STORAGE_KEY = 'settings.collapsedTriageSection';
const HIDDEN_TRIAGE_SECTIONS_STORAGE_KEY = 'settings.hiddenTriageSections';
const NOTIFICATION_PERMISSION_REQUESTED_STORAGE_KEY = 'settings.hasRequestedNotificationPermission';

/** The remembered per-task lens is capped so the map cannot grow unboundedly. */
const PREFERRED_SESSION_LENS_CAP = 50;

/**
 * One setting read, allowed to fail without taking the others with it.
 *
 * hydrate() must always end hydrated (see its own comment), and the obvious way
 * to get that - a single try/catch around one Promise.all - makes ONE
 * unreadable key reset EVERY setting to its default. That is not a tidy
 * distinction. `backgroundNotificationsMode` would fall back to
 * 'foreground-service' for someone who chose 'push-only', starting the exact
 * service the `hydrated` gate exists to withhold; and `pushCategoriesEnabled`
 * would fall back to the defaults, which the next established bootstrap
 * registers with the desktop, re-enabling categories the user switched off.
 * Both are then made permanent by the first subsequent toggle, because those
 * setters persist the whole map they hold in memory.
 *
 * `async` rather than a bare `.catch()` so a synchronous throw out of
 * SecureStore is caught too, matching what the enclosing try/catch used to do.
 */
async function readSetting(storageKey: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(storageKey);
  } catch {
    return null;
  }
}

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

/**
 * The Agents-feed sections (by display TITLE, e.g. "Idle") the user has
 * collapsed. Each header collapses on its own, any number at once.
 *
 * It used to be ONE nullable title, where collapsing a section re-expanded
 * whichever was collapsed before. That was harmless with two sections and
 * broke at four (Idle, Active, Queued, Paused): with Idle collapsed, tapping
 * Active collapsed Active and re-opened Idle above it, which pushed Active
 * down the screen and read as a tap that did nothing. The desktop's Agent
 * Monitor has no collapsible sections at all (it hides them with toolbar
 * filters, which the section filter mirrors), so there was no rule to copy.
 *
 * Keyed by title, so a renamed section needs its old title migrated here:
 * the running sessions' section was "Thinking" until it became "Active", and
 * an install that had it collapsed would otherwise silently lose that.
 */
const LEGACY_COLLAPSED_TRIAGE_TITLES: ReadonlyMap<string, string> = new Map([['Thinking', 'Active']]);

function currentCollapsedTitle(title: string): string {
  return LEGACY_COLLAPSED_TRIAGE_TITLES.get(title) ?? title;
}

/** The list under the current key. Anything that is not an array of strings reads as nothing collapsed. */
function parseCollapsedTriageSections(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const titles = parsed.filter((title): title is string => typeof title === 'string').map(currentCollapsedTitle);
    return Array.from(new Set(titles));
  } catch {
    return [];
  }
}

/** The single title the legacy key held, as a one-entry list (or none). */
function parseLegacyCollapsedTriageSection(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? [currentCollapsedTitle(parsed)] : [];
  } catch {
    return [];
  }
}

/**
 * The Agents-feed sections (by display TITLE) the user has hidden with the
 * section filter. A list, like the collapse: any number can be hidden at
 * once. Anything that is not an array of strings reads as nothing hidden, so
 * a corrupt value can never blank the feed.
 */
function parseHiddenTriageSections(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((title): title is string => typeof title === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Per-category defaults. A literal table rather than a loop over
 * PUSH_CATEGORIES so that a category added to the protocol becomes a COMPILE
 * ERROR here (Record<PushCategory, boolean> demands every key) instead of
 * silently inheriting whatever the loop wrote. That is strictly stronger than
 * the absent-means-enabled rule this replaced, which existed to stop a new
 * category going dark.
 *
 * spawn-stalled is the one default-off entry: "slow starts" is noise nobody
 * asked for. The category stays in the protocol, the Settings row, and the
 * Notifee channel - it is defaulted off, not removed, so anyone who wants it
 * can switch it back on and that choice sticks.
 */
const PUSH_CATEGORY_DEFAULTS: Record<PushCategory, boolean> = {
  'input-required': true,
  'turn-complete': true,
  'session-failed': true,
  'plan-complete': true,
  'spawn-stalled': false,
};

function defaultPushCategoriesEnabled(): Record<PushCategory, boolean> {
  return { ...PUSH_CATEGORY_DEFAULTS };
}

/**
 * Overlays a stored map onto the defaults. Keys that are absent or not boolean
 * keep their default.
 *
 * `migrateSpawnStalledOff` is the v1 -> v2 migration, and it is deliberately
 * narrow: it forces spawn-stalled to false and copies EVERY OTHER category's
 * stored value through unchanged. So a v1 user who had turned some other
 * category off keeps it off, and the migration can never turn spawn-stalled
 * back ON for anyone - the direction that would reintroduce the noise. Once the
 * user touches any toggle, the whole map is written to v2 and read back
 * verbatim, so a deliberate re-enable sticks.
 */
function parsePushCategoriesEnabled(raw: string | null, migrateSpawnStalledOff = false): Record<PushCategory, boolean> {
  const parsed = defaultPushCategoriesEnabled();
  if (raw === null) return parsed;
  try {
    const stored: unknown = JSON.parse(raw);
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return parsed;
    for (const category of PUSH_CATEGORIES) {
      const storedValue = (stored as Record<string, unknown>)[category];
      if (typeof storedValue === 'boolean') parsed[category] = storedValue;
    }
    if (migrateSpawnStalledOff) parsed['spawn-stalled'] = false;
    return parsed;
  } catch {
    return parsed;
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
  /** Per-category push + local-notification opt-in; see PUSH_CATEGORY_DEFAULTS. */
  pushCategoriesEnabled: Record<PushCategory, boolean>;
  /** The Agents-feed sections (by title) the user has collapsed, each independently; empty expands them all. */
  collapsedTriageSections: string[];
  /** The Agents-feed sections (by title) the section filter hides; empty shows them all. Never applies to the Board. */
  hiddenTriageSections: string[];
  /**
   * Whether the POST_NOTIFICATIONS runtime prompt has ever been shown. The
   * prompt fires on session establishment, which repeats on every reconnect,
   * so this flag is what makes it once-ever.
   *
   * It doubles as the only record that the app has ever ASKED: Android reports
   * no NOT_DETERMINED status, so a permission never requested is
   * indistinguishable from one refused, and both the keepalive gate and the
   * Settings "blocked" notice need to tell those apart.
   */
  hasRequestedNotificationPermission: boolean;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setDictationMode: (mode: DictationMode) => Promise<void>;
  markSessionModeHintSeen: () => Promise<void>;
  setHapticsEnabled: (enabled: boolean) => Promise<void>;
  setBackgroundNotificationsMode: (mode: BackgroundNotificationsMode) => Promise<void>;
  setPreferredSessionLens: (taskId: string, lens: PreferredSessionLens) => Promise<void>;
  setPushCategoryEnabled: (category: PushCategory, enabled: boolean) => Promise<void>;
  toggleTriageSectionCollapsed: (title: string) => Promise<void>;
  toggleTriageSectionHidden: (title: string) => Promise<void>;
  showAllTriageSections: () => Promise<void>;
  markNotificationPermissionRequested: () => Promise<void>;
  /** Clears preferences that belong to the paired desktop (the lens map, keyed
   * by its task IDs), which go stale on unpair or a new pairing. */
  clearDesktopScopedPreferences: () => Promise<void>;
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
  pushCategoriesEnabled: defaultPushCategoriesEnabled(),
  collapsedTriageSections: [],
  hiddenTriageSections: [],
  hasRequestedNotificationPermission: false,
  hydrated: false,

  /**
   * `hydrated` means "the persisted values have been resolved, or provably
   * cannot be", NOT "a read succeeded". A rejected read still ends hydrated,
   * on the in-memory defaults.
   *
   * That distinction is load-bearing rather than tidy-minded. Two gates now
   * hang off this flag - the background keepalive and the one-shot
   * POST_NOTIFICATIONS prompt (both in connectionManager.ts) - and they read a
   * false flag as "do not act yet". If a single Keystore hiccup could leave the
   * flag false forever, one failed read at boot would silently disable the
   * notification permission request for the entire lifetime of that install,
   * which is precisely the bug those gates were added to fix.
   *
   * Each key is read through readSetting, which fails alone: see its comment
   * for why one failure must not default the others.
   */
  hydrate: async () => {
    const [
      storedDictationMode,
      storedModeHintSeen,
      storedHapticsEnabled,
      storedBackgroundMode,
      storedLensMap,
      storedPushCategoriesEnabled,
      storedLegacyPushCategoriesEnabled,
      storedCollapsedTriageSections,
      storedLegacyCollapsedTriageSection,
      storedHiddenTriageSections,
      storedNotificationPermissionRequested,
    ] = await Promise.all([
      readSetting(DICTATION_MODE_STORAGE_KEY),
      readSetting(SESSION_MODE_HINT_STORAGE_KEY),
      readSetting(HAPTICS_ENABLED_STORAGE_KEY),
      readSetting(BACKGROUND_NOTIFICATIONS_MODE_STORAGE_KEY),
      readSetting(PREFERRED_SESSION_LENS_STORAGE_KEY),
      readSetting(PUSH_CATEGORIES_ENABLED_STORAGE_KEY),
      readSetting(PUSH_CATEGORIES_ENABLED_LEGACY_STORAGE_KEY),
      readSetting(COLLAPSED_TRIAGE_SECTIONS_STORAGE_KEY),
      readSetting(COLLAPSED_TRIAGE_SECTION_LEGACY_STORAGE_KEY),
      readSetting(HIDDEN_TRIAGE_SECTIONS_STORAGE_KEY),
      readSetting(NOTIFICATION_PERMISSION_REQUESTED_STORAGE_KEY),
    ]);
    set({
      dictationMode: isDictationMode(storedDictationMode) ? storedDictationMode : 'auto-send',
      hasSeenSessionModeHint: storedModeHintSeen === 'true',
      hapticsEnabled: storedHapticsEnabled !== 'false',
      backgroundNotificationsMode: isBackgroundNotificationsMode(storedBackgroundMode)
        ? storedBackgroundMode
        : 'foreground-service',
      preferredSessionLensByTaskId: parsePreferredLensMap(storedLensMap),
      // v2 present means the map was written under the current rules; read it
      // verbatim. v2 absent means this install predates the spawn-stalled
      // default change, so its v1 map is read with that one category forced
      // off. hydrate stays read-only, so the migration simply re-runs (with the
      // same result) until the first toggle writes v2.
      pushCategoriesEnabled:
        storedPushCategoriesEnabled !== null
          ? parsePushCategoriesEnabled(storedPushCategoriesEnabled)
          : parsePushCategoriesEnabled(storedLegacyPushCategoriesEnabled, true),
      // The list key present means it was written under the per-section rule;
      // absent means this install still has at most the old single title,
      // which carries over as a one-entry list. Read-only, like the push map:
      // the migration re-runs until the first toggle writes the list key.
      collapsedTriageSections:
        storedCollapsedTriageSections !== null
          ? parseCollapsedTriageSections(storedCollapsedTriageSections)
          : parseLegacyCollapsedTriageSection(storedLegacyCollapsedTriageSection),
      hiddenTriageSections: parseHiddenTriageSections(storedHiddenTriageSections),
      hasRequestedNotificationPermission: storedNotificationPermissionRequested === 'true',
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

  markNotificationPermissionRequested: async () => {
    set({ hasRequestedNotificationPermission: true });
    await SecureStore.setItemAsync(NOTIFICATION_PERMISSION_REQUESTED_STORAGE_KEY, 'true');
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

  setPushCategoryEnabled: async (category, enabled) => {
    const nextMap = { ...get().pushCategoriesEnabled, [category]: enabled };
    set({ pushCategoriesEnabled: nextMap });
    await SecureStore.setItemAsync(PUSH_CATEGORIES_ENABLED_STORAGE_KEY, JSON.stringify(nextMap));
  },

  toggleTriageSectionCollapsed: async (title) => {
    // Flips this section alone; every other section keeps its state.
    const current = get().collapsedTriageSections;
    const next = current.includes(title)
      ? current.filter((collapsedTitle) => collapsedTitle !== title)
      : [...current, title];
    set({ collapsedTriageSections: next });
    await SecureStore.setItemAsync(COLLAPSED_TRIAGE_SECTIONS_STORAGE_KEY, JSON.stringify(next));
  },

  toggleTriageSectionHidden: async (title) => {
    const current = get().hiddenTriageSections;
    const next = current.includes(title) ? current.filter((hiddenTitle) => hiddenTitle !== title) : [...current, title];
    set({ hiddenTriageSections: next });
    await SecureStore.setItemAsync(HIDDEN_TRIAGE_SECTIONS_STORAGE_KEY, JSON.stringify(next));
  },

  showAllTriageSections: async () => {
    set({ hiddenTriageSections: [] });
    await SecureStore.setItemAsync(HIDDEN_TRIAGE_SECTIONS_STORAGE_KEY, JSON.stringify([]));
  },

  clearDesktopScopedPreferences: async () => {
    set({ preferredSessionLensByTaskId: {} });
    await SecureStore.setItemAsync(PREFERRED_SESSION_LENS_STORAGE_KEY, JSON.stringify({}));
  },
}));
