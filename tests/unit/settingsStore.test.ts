import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/state/settingsStore';

// In-memory secure store so the vitest (node) run has no native module.
const { storedValues, readFailure } = vi.hoisted(() => ({
  storedValues: new Map<string, string>(),
  readFailure: { active: false },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: (key: string) =>
    readFailure.active ? Promise.reject(new Error('keystore unavailable')) : Promise.resolve(storedValues.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    storedValues.set(key, value);
    return Promise.resolve();
  },
}));

describe('settingsStore - preferred session lens per task', () => {
  beforeEach(() => {
    storedValues.clear();
    useSettingsStore.setState({ preferredSessionLensByTaskId: {} });
  });

  it('remembers the last chosen lens per task and persists it', async () => {
    await useSettingsStore.getState().setPreferredSessionLens('task-1', 'chat');
    await useSettingsStore.getState().setPreferredSessionLens('task-2', 'terminal');

    expect(useSettingsStore.getState().preferredSessionLensByTaskId).toEqual({
      'task-1': 'chat',
      'task-2': 'terminal',
    });
    expect(JSON.parse(storedValues.get('settings.preferredSessionLensByTaskId') ?? '{}')).toEqual({
      'task-1': 'chat',
      'task-2': 'terminal',
    });
  });

  it('hydrate restores the map and drops malformed entries', async () => {
    storedValues.set(
      'settings.preferredSessionLensByTaskId',
      JSON.stringify({ 'task-1': 'chat', 'task-2': 'sideways', 'task-3': 'terminal' }),
    );
    await useSettingsStore.getState().hydrate();
    expect(useSettingsStore.getState().preferredSessionLensByTaskId).toEqual({
      'task-1': 'chat',
      'task-3': 'terminal',
    });
  });

  it('caps the map at 50 tasks, evicting the least recently chosen', async () => {
    for (let taskIndex = 0; taskIndex < 50; taskIndex++) {
      await useSettingsStore.getState().setPreferredSessionLens(`task-${taskIndex}`, 'chat');
    }
    // Re-choosing task-0 refreshes its recency before the map overflows.
    await useSettingsStore.getState().setPreferredSessionLens('task-0', 'terminal');
    await useSettingsStore.getState().setPreferredSessionLens('task-overflow', 'chat');

    const lensMap = useSettingsStore.getState().preferredSessionLensByTaskId;
    expect(Object.keys(lensMap)).toHaveLength(50);
    expect(lensMap['task-0']).toBe('terminal');
    expect(lensMap['task-overflow']).toBe('chat');
    // task-1 was the least recently chosen once task-0 was refreshed.
    expect(lensMap['task-1']).toBeUndefined();
  });
});

describe('settingsStore - per-category push preferences', () => {
  beforeEach(() => {
    storedValues.clear();
    useSettingsStore.setState({
      pushCategoriesEnabled: {
        'input-required': true,
        'turn-complete': true,
        'session-failed': true,
        'plan-complete': true,
        'spawn-stalled': true,
      },
    });
  });

  it('defaults every category to enabled', () => {
    expect(useSettingsStore.getState().pushCategoriesEnabled).toEqual({
      'input-required': true,
      'turn-complete': true,
      'session-failed': true,
      'plan-complete': true,
      'spawn-stalled': true,
    });
  });

  it('toggles one category without disturbing the others, and persists', async () => {
    await useSettingsStore.getState().setPushCategoryEnabled('spawn-stalled', false);

    expect(useSettingsStore.getState().pushCategoriesEnabled).toEqual({
      'input-required': true,
      'turn-complete': true,
      'session-failed': true,
      'plan-complete': true,
      'spawn-stalled': false,
    });
    expect(JSON.parse(storedValues.get('settings.pushCategoriesEnabled') ?? '{}')).toMatchObject({ 'spawn-stalled': false });
  });

  it('hydrate restores stored values and defaults a missing key to enabled (forward-compat)', async () => {
    storedValues.set('settings.pushCategoriesEnabled', JSON.stringify({ 'input-required': false, 'turn-complete': false }));
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().pushCategoriesEnabled).toEqual({
      'input-required': false,
      'turn-complete': false,
      'session-failed': true,
      'plan-complete': true,
      'spawn-stalled': true,
    });
  });

  it('hydrate ignores a malformed stored value and falls back to all-enabled', async () => {
    storedValues.set('settings.pushCategoriesEnabled', 'not json');
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().pushCategoriesEnabled).toEqual({
      'input-required': true,
      'turn-complete': true,
      'session-failed': true,
      'plan-complete': true,
      'spawn-stalled': true,
    });
  });

  // 'not json' above throws inside JSON.parse and is caught by the outer
  // catch, never reaching parsePushCategoriesEnabled's non-object guard
  // (typeof stored !== 'object' || stored === null || Array.isArray(stored)).
  // These three are all VALID JSON that parses to a non-plain-object value,
  // so they exercise that guard directly instead.
  it.each([
    ['an array', '[1,2,3]'],
    ['null', 'null'],
    ['a bare number', '5'],
  ])('hydrate falls back to all-enabled when the stored JSON parses to %s, not a plain object', async (_description, raw) => {
    storedValues.set('settings.pushCategoriesEnabled', raw);
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().pushCategoriesEnabled).toEqual({
      'input-required': true,
      'turn-complete': true,
      'session-failed': true,
      'plan-complete': true,
      'spawn-stalled': true,
    });
  });
});

describe('settingsStore - collapsed triage section', () => {
  beforeEach(() => {
    storedValues.clear();
    useSettingsStore.setState({ collapsedTriageSection: null });
  });

  it('collapses a section by title and persists it', async () => {
    await useSettingsStore.getState().toggleTriageSectionCollapsed('Idle');

    expect(useSettingsStore.getState().collapsedTriageSection).toBe('Idle');
    expect(storedValues.get('settings.collapsedTriageSection')).toBe(JSON.stringify('Idle'));
  });

  it('toggles the same title back to expanded (null)', async () => {
    await useSettingsStore.getState().toggleTriageSectionCollapsed('Idle');
    await useSettingsStore.getState().toggleTriageSectionCollapsed('Idle');

    expect(useSettingsStore.getState().collapsedTriageSection).toBeNull();
    expect(storedValues.get('settings.collapsedTriageSection')).toBe(JSON.stringify(null));
  });

  it('collapsing a different title replaces the collapsed section rather than accumulating', async () => {
    await useSettingsStore.getState().toggleTriageSectionCollapsed('Idle');
    await useSettingsStore.getState().toggleTriageSectionCollapsed('Needs you');

    // A two-state accordion: collapsing a different section leaves ONLY that
    // section collapsed, not a set of both.
    expect(useSettingsStore.getState().collapsedTriageSection).toBe('Needs you');
    expect(storedValues.get('settings.collapsedTriageSection')).toBe(JSON.stringify('Needs you'));
  });

  it('hydrate restores a stored string value', async () => {
    storedValues.set('settings.collapsedTriageSection', JSON.stringify('Idle'));
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().collapsedTriageSection).toBe('Idle');
  });

  it('hydrate falls back to null on malformed JSON', async () => {
    storedValues.set('settings.collapsedTriageSection', 'not json');
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().collapsedTriageSection).toBeNull();
  });

  it.each([
    ['a bare number', '5'],
    ['null', 'null'],
    ['an array', '[1,2]'],
  ])('hydrate falls back to null when the stored JSON parses to %s, not a string', async (_description, raw) => {
    storedValues.set('settings.collapsedTriageSection', raw);
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().collapsedTriageSection).toBeNull();
  });
});

describe('settingsStore - clearDesktopScopedPreferences', () => {
  beforeEach(() => {
    storedValues.clear();
    useSettingsStore.setState({ preferredSessionLensByTaskId: {} });
  });

  it('resets preferredSessionLensByTaskId and persists the empty map', async () => {
    await useSettingsStore.getState().setPreferredSessionLens('task-1', 'chat');
    await useSettingsStore.getState().clearDesktopScopedPreferences();

    expect(useSettingsStore.getState().preferredSessionLensByTaskId).toEqual({});
    expect(storedValues.get('settings.preferredSessionLensByTaskId')).toBe('{}');
  });
});

/**
 * `hydrated` gates the background keepalive and the one-shot
 * POST_NOTIFICATIONS prompt (both in connectionManager.ts), and both read a
 * false flag as "do not act yet". So a read failure that left the flag false
 * forever would silently disable the notification permission request for the
 * whole life of that install - the exact bug those gates exist to fix.
 */
describe('settingsStore - hydrate never gets stuck unhydrated', () => {
  beforeEach(() => {
    storedValues.clear();
    readFailure.active = false;
    useSettingsStore.setState({ hydrated: false, hapticsEnabled: true, hasRequestedNotificationPermission: false });
  });

  it('still ends hydrated, on defaults, when the secure store read rejects', async () => {
    readFailure.active = true;

    await expect(useSettingsStore.getState().hydrate()).resolves.toBeUndefined();

    expect(useSettingsStore.getState().hydrated).toBe(true);
    expect(useSettingsStore.getState().backgroundNotificationsMode).toBe('foreground-service');
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(false);
  });

  it('a later successful hydrate still reads the persisted values', async () => {
    readFailure.active = true;
    await useSettingsStore.getState().hydrate();

    readFailure.active = false;
    storedValues.set('settings.backgroundNotificationsMode', 'push-only');
    storedValues.set('settings.hasRequestedNotificationPermission', 'true');
    await useSettingsStore.getState().hydrate();

    expect(useSettingsStore.getState().backgroundNotificationsMode).toBe('push-only');
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(true);
  });
});
