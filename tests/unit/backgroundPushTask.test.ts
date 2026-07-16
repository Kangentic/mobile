/**
 * The killed-app data-message path: blob extraction from the shapes
 * expo-notifications delivers, and the hard guarantee that a failed
 * decrypt displays the generic placeholder - never ciphertext
 * (e2e-notification-privacy.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const secureStoreState = vi.hoisted(() => ({ storedValues: new Map<string, string>() }));
const taskManagerState = vi.hoisted(() => ({
  defineTask: vi.fn(),
  registerTaskAsync: vi.fn(async () => null),
  displayNotification: vi.fn(async (_notification: unknown) => 'notification-id'),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreState.storedValues.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreState.storedValues.set(key, value);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('expo-task-manager', () => ({
  defineTask: taskManagerState.defineTask,
}));

vi.mock('expo-notifications', () => ({
  registerTaskAsync: taskManagerState.registerTaskAsync,
}));

vi.mock('@notifee/react-native', () => ({
  default: {
    displayNotification: taskManagerState.displayNotification,
    createChannels: vi.fn(async () => undefined),
  },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

type BackgroundPushTaskModule = typeof import('@/notifications/backgroundPushTask');

async function loadModule(): Promise<BackgroundPushTaskModule> {
  return import('@/notifications/backgroundPushTask');
}

type TaskExecutor = (body: { data: unknown; error: null; executionInfo: { taskName: string } }) => Promise<void> | void;

describe('backgroundPushTask', () => {
  beforeEach(() => {
    vi.resetModules();
    secureStoreState.storedValues.clear();
    taskManagerState.defineTask.mockClear();
    taskManagerState.registerTaskAsync.mockClear();
    taskManagerState.displayNotification.mockClear();
  });

  it('extracts the blob from the direct and dataString-wrapped payload shapes', async () => {
    const { extractBlobFromTaskData } = await loadModule();
    expect(extractBlobFromTaskData({ blob: 'direct-blob' })).toBe('direct-blob');
    expect(extractBlobFromTaskData({ dataString: JSON.stringify({ blob: 'wrapped-blob' }) })).toBe('wrapped-blob');
    expect(extractBlobFromTaskData({ body: JSON.stringify({ blob: 'body-blob' }) })).toBe('body-blob');
    expect(extractBlobFromTaskData({ dataString: 'not json' })).toBeNull();
    expect(extractBlobFromTaskData({ other: 'field' })).toBeNull();
    expect(extractBlobFromTaskData('a string')).toBeNull();
    expect(extractBlobFromTaskData(null)).toBeNull();
  });

  it('registers the task once and displays the placeholder when the blob cannot be decrypted', async () => {
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    registerBackgroundPushTask();

    expect(taskManagerState.defineTask).toHaveBeenCalledTimes(1);
    expect(taskManagerState.registerTaskAsync).toHaveBeenCalledTimes(1);

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'not-a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
    const notification = taskManagerState.displayNotification.mock.calls[0][0] as {
      title: string;
      body: string;
      android?: { channelId?: string };
    };
    expect(notification.title).toBe('Kangentic');
    expect(notification.body).toBe('Agent needs attention');
    expect(notification.android?.channelId).toBe('needs-attention');
  });

  it('ignores notification-response payloads (action taps are the tap router job)', async () => {
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();
    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;

    await executor({
      data: { actionIdentifier: 'default', notification: {} },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).not.toHaveBeenCalled();
  });
});
