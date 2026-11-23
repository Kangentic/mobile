import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_OPEN_CLAIM_WINDOW_MS,
  claimTaskOpen,
  isTaskOpenPending,
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

  /**
   * The peek `useResumeOnOpen` seeds its first render from (protocol 0.29.0's
   * pause line under Resume). It must answer as the claim would, and never take
   * the open: the claim that follows it is the one that counts. Mutations seen
   * failing: the peek clearing the slot (the later claim case), and the task
   * or window check dropped (the other-task and expired cases).
   */
  describe('isTaskOpenPending', () => {
    it('is true for its own task inside the window, up to the edge', () => {
      noteTaskOpened('task-a', 1000);
      expect(isTaskOpenPending('task-a', 1001)).toBe(true);
      expect(isTaskOpenPending('task-a', 1000 + TASK_OPEN_CLAIM_WINDOW_MS)).toBe(true);
    });

    it('is false for another task, past the window, and with nothing noted', () => {
      expect(isTaskOpenPending('task-a', 1000)).toBe(false);
      noteTaskOpened('task-a', 1000);
      expect(isTaskOpenPending('task-b', 1001)).toBe(false);
      expect(isTaskOpenPending('task-a', 1000 + TASK_OPEN_CLAIM_WINDOW_MS + 1)).toBe(false);
    });

    it('never consumes the open: the claim after it still succeeds, and nothing is pending once it has', () => {
      noteTaskOpened('task-a', 1000);
      expect(isTaskOpenPending('task-a', 1001)).toBe(true);
      expect(isTaskOpenPending('task-a', 1002)).toBe(true);
      expect(claimTaskOpen('task-a', 1003)).toBe(true);
      expect(isTaskOpenPending('task-a', 1004)).toBe(false);
    });
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
