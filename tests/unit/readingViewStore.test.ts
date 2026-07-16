import { beforeEach, describe, expect, it } from 'vitest';
import { useReadingViewStore } from '../../src/state/readingViewStore';

describe('readingViewStore', () => {
  beforeEach(() => {
    useReadingViewStore.getState().reset();
  });

  it('appends lines and bumps the revision', () => {
    useReadingViewStore.getState().applyCleanLines('sess-1', ['one'], false);
    useReadingViewStore.getState().applyCleanLines('sess-1', ['two', 'three'], false);
    const state = useReadingViewStore.getState().bySessionId['sess-1'];
    expect(state.lines).toEqual(['one', 'two', 'three']);
    expect(state.revision).toBe(2);
  });

  it('replaces the buffer on reset', () => {
    useReadingViewStore.getState().applyCleanLines('sess-1', ['old'], false);
    useReadingViewStore.getState().applyCleanLines('sess-1', ['fresh frame'], true);
    expect(useReadingViewStore.getState().bySessionId['sess-1'].lines).toEqual(['fresh frame']);
  });

  it('caps the buffer at 500 lines, keeping the newest', () => {
    const bulk = Array.from({ length: 499 }, (_, index) => `line-${index}`);
    useReadingViewStore.getState().applyCleanLines('sess-1', bulk, false);
    useReadingViewStore.getState().applyCleanLines('sess-1', ['tail-1', 'tail-2'], false);
    const lines = useReadingViewStore.getState().bySessionId['sess-1'].lines;
    expect(lines).toHaveLength(500);
    expect(lines[0]).toBe('line-1');
    expect(lines[lines.length - 1]).toBe('tail-2');
  });

  it('clears one session without touching others', () => {
    useReadingViewStore.getState().applyCleanLines('sess-1', ['a'], false);
    useReadingViewStore.getState().applyCleanLines('sess-2', ['b'], false);
    useReadingViewStore.getState().clearSession('sess-1');
    expect(useReadingViewStore.getState().bySessionId['sess-1']).toBeUndefined();
    expect(useReadingViewStore.getState().bySessionId['sess-2'].lines).toEqual(['b']);
  });
});
