/**
 * The killed-app data-message path: blob extraction from the shapes
 * expo-notifications delivers, and the hard guarantee that a failed
 * decrypt displays the generic placeholder - never ciphertext
 * (e2e-notification-privacy.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { brandTokens } from '@/components/theme/tokens';

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

const decryptPushBlobMock = vi.hoisted(() => vi.fn<(blob: string) => Promise<unknown>>());

/**
 * Captured so the mock can DELEGATE to the real decrypt by default. Only the
 * test that needs a successful decrypt overrides it (with mockResolvedValueOnce,
 * which takes precedence). Without this default, a bare vi.fn() returns
 * undefined, and the placeholder test below would reach its branch by
 * coincidence rather than by exercising the real decrypt-failure path that
 * e2e-notification-privacy.md exists to protect.
 */
const pushDecryptState = vi.hoisted(() => ({
  realDecryptPushBlob: null as ((blob: string) => Promise<unknown>) | null,
}));

vi.mock('@/notifications/pushDecrypt', async () => {
  const actual = await vi.importActual<typeof import('@/notifications/pushDecrypt')>('@/notifications/pushDecrypt');
  pushDecryptState.realDecryptPushBlob = actual.decryptPushBlob;
  return { ...actual, decryptPushBlob: decryptPushBlobMock };
});

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
    decryptPushBlobMock.mockReset();
    decryptPushBlobMock.mockImplementation(async (blob) => {
      const { realDecryptPushBlob } = pushDecryptState;
      if (realDecryptPushBlob === null) {
        throw new Error('pushDecrypt mock invoked before the mocked module was ever imported');
      }
      return realDecryptPushBlob(blob);
    });
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
      android?: { channelId?: string; smallIcon?: string; color?: string };
    };
    expect(notification.title).toBe('Kangentic');
    expect(notification.body).toBe('Agent needs attention');
    expect(notification.android?.channelId).toBe('needs-attention');
    // Notifee defaults smallIcon to ic_launcher (a full-colour asset the OS
    // strips to a silhouette) unless set explicitly - see channels.ts.
    expect(notification.android?.smallIcon).toBe('notification_icon');
    expect(notification.android?.color).toBe(brandTokens.rust);
  });

  it('displays the rich notification, with the branded small icon and color, when the blob decrypts', async () => {
    decryptPushBlobMock.mockResolvedValueOnce({
      title: 'Agent needs your input',
      body: 'Ship the release',
      category: 'input-required',
      data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
    });
    const { registerBackgroundPushTask } = await loadModule();
    registerBackgroundPushTask();

    const executor = taskManagerState.defineTask.mock.calls[0][1] as TaskExecutor;
    await executor({
      data: { notification: null, data: { blob: 'a-real-envelope' } },
      error: null,
      executionInfo: { taskName: 'kangentic-background-push' },
    });

    expect(taskManagerState.displayNotification).toHaveBeenCalledTimes(1);
    const notification = taskManagerState.displayNotification.mock.calls[0][0] as {
      title: string;
      body: string;
      android?: { channelId?: string; smallIcon?: string; color?: string };
    };
    expect(notification.title).toBe('Agent needs your input');
    expect(notification.body).toBe('Ship the release');
    expect(notification.android?.channelId).toBe('needs-attention');
    expect(notification.android?.smallIcon).toBe('notification_icon');
    expect(notification.android?.color).toBe(brandTokens.rust);
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
