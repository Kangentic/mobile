import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_OPEN_CLAIM_WINDOW_MS,
  claimTaskOpen,
  noteTaskOpened,
  resetTaskOpenIntentForTests,
  subscribeTaskOpens,
} from '../../src/navigation/taskOpenIntent';

describe('taskOpenIntent', () => {
  beforeEach(() => {
    resetTaskOpenIntentForTests();
  });

  it('is claimed once, then not again', () => {
    noteTaskOpened('task-a', 1000);
    expect(claimTaskOpen('task-a', 1001)).toBe(true);
    expect(claimTaskOpen('task-a', 1002)).toBe(false);
  });

  it("does not let another task's claim consume the open", () => {
    noteTaskOpened('task-a', 1000);
    expect(claimTaskOpen('task-b', 1001)).toBe(false);
    expect(claimTaskOpen('task-a', 1002)).toBe(true);
  });

  it('is claimable exactly at the window edge', () => {
    noteTaskOpened('task-a', 1000);
    expect(claimTaskOpen('task-a', 1000 + TASK_OPEN_CLAIM_WINDOW_MS)).toBe(true);
  });

  it('is false past the window and still consumes the open', () => {
    noteTaskOpened('task-a', 1000);
    expect(claimTaskOpen('task-a', 1000 + TASK_OPEN_CLAIM_WINDOW_MS + 1)).toBe(false);
    expect(claimTaskOpen('task-a', 1000 + 1)).toBe(false);
  });

  it('lets a newer note supersede an older one', () => {
    noteTaskOpened('task-a', 1000);
    noteTaskOpened('task-b', 1001);
    expect(claimTaskOpen('task-a', 1002)).toBe(false);
    expect(claimTaskOpen('task-b', 1002)).toBe(true);
  });

  it('calls subscribers on each note until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTaskOpens(listener);
    noteTaskOpened('task-a', 1);
    noteTaskOpened('task-b', 2);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    noteTaskOpened('task-c', 3);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
