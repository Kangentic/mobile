import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/state/settingsStore';

// In-memory secure store so the vitest (node) run has no native module.
const { storedValues } = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: (key: string) => Promise.resolve(storedValues.get(key) ?? null),
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
