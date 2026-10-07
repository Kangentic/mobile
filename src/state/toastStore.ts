import { create } from 'zustand';

/**
 * App-wide toasts, a port of the desktop's (kangentic
 * src/renderer/stores/toast-store.ts): a short message in a card at the
 * bottom of the screen, whatever screen that is, that closes on its own.
 * Raised from outside React (a failed Resume settles on a board event long
 * after the screen that started it may have closed), so it is a store, and
 * `ToastHost` in the root layout is its only renderer.
 *
 * In memory only: a toast reports something that just happened.
 */
export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

/** The desktop's defaults (`notifications.toasts` in its shared/types.ts): 4 s up, at most 5 at once. */
export const TOAST_DURATION_MS = 4_000;
export const TOAST_MAX_COUNT = 5;

interface ToastStoreState {
  toasts: Toast[];
  /** Shows a toast and returns its id. The variant defaults to `info`, as on the desktop. */
  addToast: (input: { message: string; variant?: ToastVariant }) => string;
  dismissToast: (id: string) => void;
  reset: () => void;
}

let toastCounter = 0;

export const useToastStore = create<ToastStoreState>((set, get) => ({
  toasts: [],
  addToast: ({ message, variant = 'info' }) => {
    toastCounter += 1;
    const id = `toast-${toastCounter}`;
    // Every toast here closes on its own, so the desktop's limit (drop the
    // oldest self-closing toasts first, never the newest) reduces to keeping
    // the newest TOAST_MAX_COUNT.
    set((state) => ({ toasts: [...state.toasts, { id, message, variant }].slice(-TOAST_MAX_COUNT) }));
    // The auto-dismiss is a JS timer, never an animation's completion
    // callback: a lost Reanimated frame must not leave a toast on screen
    // (motion-conventions.md, the one-shot tween bullet).
    setTimeout(() => get().dismissToast(id), TOAST_DURATION_MS);
    return id;
  },
  dismissToast: (id) =>
    set((state) => {
      if (!state.toasts.some((toast) => toast.id === id)) return state;
      return { toasts: state.toasts.filter((toast) => toast.id !== id) };
    }),
  reset: () => set({ toasts: [] }),
}));
