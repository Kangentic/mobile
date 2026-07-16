import { useEffect, useRef, useState } from 'react';

/**
 * Defers unmounting for `exitDurationMs` after `visible` flips false, so an
 * exiting animation inside a container (Sheet's RN Modal) gets to finish
 * before the container itself is torn down. Returns whether the container
 * should still render.
 *
 * Flipping `visible` back to true during the exit window cancels the pending
 * unmount immediately.
 */
export function useDeferredUnmount(visible: boolean, exitDurationMs: number): boolean {
  const [shouldRender, setShouldRender] = useState(visible);
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Becoming visible re-renders as mounted immediately (render-time state
  // adjustment, not a setState-in-effect); only the delayed unmount goes
  // through a timer.
  if (visible && !shouldRender) {
    setShouldRender(true);
  }

  useEffect(() => {
    if (visible) {
      if (unmountTimerRef.current !== null) {
        clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
      return;
    }
    unmountTimerRef.current = setTimeout(() => {
      unmountTimerRef.current = null;
      setShouldRender(false);
    }, exitDurationMs);
    return () => {
      if (unmountTimerRef.current !== null) {
        clearTimeout(unmountTimerRef.current);
        unmountTimerRef.current = null;
      }
    };
  }, [visible, exitDurationMs]);

  return shouldRender;
}
