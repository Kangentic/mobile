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
