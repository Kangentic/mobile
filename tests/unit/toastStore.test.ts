/**
 * The app-wide toast store, a port of the desktop's: a toast closes on its own
 * after the desktop's 4 s, at most 5 are up at once, and the newest always
 * shows.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_DURATION_MS, TOAST_MAX_COUNT, useToastStore } from '@/state/toastStore';

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useToastStore', () => {
  it('shows a toast, info by default, until its duration passes', () => {
    const id = useToastStore.getState().addToast({ message: 'Saved' });
    expect(useToastStore.getState().toasts).toEqual([{ id, message: 'Saved', variant: 'info' }]);

    vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('dismisses one toast early and leaves the others', () => {
    const first = useToastStore.getState().addToast({ message: 'First', variant: 'warning' });
    useToastStore.getState().addToast({ message: 'Second', variant: 'warning' });

    useToastStore.getState().dismissToast(first);

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(['Second']);
  });

  it('keeps the newest five when more arrive at once', () => {
    for (let index = 1; index <= TOAST_MAX_COUNT + 2; index += 1) {
      useToastStore.getState().addToast({ message: `Toast ${index}` });
    }

    expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(['Toast 3', 'Toast 4', 'Toast 5', 'Toast 6', 'Toast 7']);
  });
});
