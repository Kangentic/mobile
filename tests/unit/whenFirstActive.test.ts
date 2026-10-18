/**
 * The locked-launch guard. Since iOS gained the `remote-notification`
 * background mode (sealed clears, protocol 0.23.0), the OS can launch the whole
 * app in the background, often with the phone LOCKED, where every
 * `WHEN_UNLOCKED` Keychain read throws and settingsStore.hydrate() would settle
 * on defaults. So boot work that reads those items waits for the first
 * 'active' in exactly that case, and runs at once in every other.
 *
 * Mutations that redden this, each seen red: never defer (the deferral and
 * cancel rows run the work at once); drop the `AppState.currentState !==
 * 'background'` half of the guard, deferring every iOS launch (the ordinary
 * and already-in-front rows never run).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios' }));
const appStateMock = vi.hoisted(() => {
  const listeners = new Set<(status: string) => void>();
  return {
    currentState: 'background' as string | null,
    listeners,
    emit(status: string): void {
      appStateMock.currentState = status;
      for (const listener of [...listeners]) listener(status);
    },
  };
});

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appStateMock.currentState;
    },
    addEventListener: (_type: string, handler: (status: string) => void) => {
      appStateMock.listeners.add(handler);
      return { remove: () => appStateMock.listeners.delete(handler) };
    },
  },
  Platform: platformMock,
}));

async function loadHelper() {
  return (await import('@/lib/whenFirstActive')).runWhenFirstActive;
}

describe('runWhenFirstActive', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'ios';
    appStateMock.currentState = 'background';
    appStateMock.listeners.clear();
  });

  it('defers an iOS background launch until the app first comes to the front, then runs once', async () => {
    const runWhenFirstActive = await loadHelper();
    const work = vi.fn();

    runWhenFirstActive(work);
    expect(work).not.toHaveBeenCalled();

    appStateMock.emit('inactive');
    appStateMock.emit('background');
    expect(work).not.toHaveBeenCalled();

    appStateMock.emit('active');
    expect(work).toHaveBeenCalledTimes(1);

    appStateMock.emit('background');
    appStateMock.emit('active');
    expect(work).toHaveBeenCalledTimes(1);
    expect(appStateMock.listeners.size).toBe(0);
  });

  it('never runs a deferred launch whose cancel was called first', async () => {
    const runWhenFirstActive = await loadHelper();
    const work = vi.fn();

    const cancel = runWhenFirstActive(work);
    cancel();
    appStateMock.emit('active');

    expect(work).not.toHaveBeenCalled();
  });

  it.each([
    ['an ordinary iOS launch, mid didFinishLaunching', 'ios' as const, 'inactive'],
    ['an iOS launch already in front', 'ios' as const, 'active'],
    ['an Android launch, whatever AppState reads', 'android' as const, 'background'],
  ])('runs at once for %s', async (_label, platform, state) => {
    platformMock.OS = platform;
    appStateMock.currentState = state;
    const runWhenFirstActive = await loadHelper();
    const work = vi.fn();

    runWhenFirstActive(work);

    expect(work).toHaveBeenCalledTimes(1);
    expect(appStateMock.listeners.size).toBe(0);
  });
});
