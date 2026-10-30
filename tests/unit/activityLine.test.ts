/**
 * formatActivityLine: what a session is doing, as one line - the desktop's own
 * words for an activity reason ("Asking you a question", "Running Bash",
 * "Idle for 12m"), plus the two lines a terminal needs before it runs
 * ("Waiting to start", "Starting...").
 *
 * The durations are the forced deviation from the desktop: whole minutes,
 * TRUNCATED, and left off below a minute. `formatDuration` rounds, so each
 * duration case picks a span where rounding and truncation disagree (12m59s
 * must read 12m, never 13m; 65m30s must read 1h 5m, never 1h 6m).
 */
import { describe, expect, it } from 'vitest';
import type { ActivityReasonWire, ActivityStateWire, ReadStreamSessionStatusWire } from '@kangentic/protocol';
import { formatActivityLine, type ActivityLineInput } from '@/lib/activityLine';

const MINUTE_MS = 60_000;
const NOW_MS = 10_000_000_000;

function lineInput(overrides: Partial<ActivityLineInput> & { state: ActivityStateWire }): ActivityLineInput {
  return { reason: null, sessionStatus: 'running', activityObserved: true, ...overrides };
}

/** An input that has been waiting since `elapsedMs` before NOW_MS. */
function waitingInput(state: 'permission' | 'idle', elapsedMs: number): ActivityLineInput {
  return lineInput({ state, reason: { kind: state, since: NOW_MS - elapsedMs } });
}

describe('formatActivityLine', () => {
  describe('before the agent runs', () => {
    it.each<[string, ReadStreamSessionStatusWire | null, boolean]>([
      ['queued and unobserved', 'queued', false],
      ['queued and observed', 'queued', true],
    ])('says "Waiting to start" for a session that is %s', (_label, sessionStatus, activityObserved) => {
      expect(formatActivityLine(lineInput({ state: 'idle', sessionStatus, activityObserved }), NOW_MS)).toBe('Waiting to start');
    });

    it.each<[string, ReadStreamSessionStatusWire | null]>([
      ['running', 'running'],
      ['not yet snapshotted', null],
    ])('says "Starting..." for a %s session the desktop has not classified', (_label, sessionStatus) => {
      expect(formatActivityLine(lineInput({ state: 'idle', sessionStatus, activityObserved: false }), NOW_MS)).toBe('Starting...');
    });

    it('does not let a stale thinking state past the unobserved gate', () => {
      expect(
        formatActivityLine(lineInput({ state: 'thinking', reason: { kind: 'turn-active' }, activityObserved: false }), NOW_MS),
      ).toBe('Starting...');
    });
  });

  /**
   * One line per wait kind (protocol 0.26.0), the desktop's own words
   * (activity-reason-text.ts); a wait whose kind the agent did not report says
   * only that it waits on the user.
   */
  describe('waiting on the user', () => {
    it('reads plainly with no wait on record', () => {
      expect(formatActivityLine(lineInput({ state: 'permission', reason: { kind: 'permission' } }), NOW_MS)).toBe('Waiting on you');
    });

    it.each<[string, 'question' | 'approval', string]>([
      ['a question', 'question', 'Asking you a question'],
      ['an approval', 'approval', 'Waiting for your approval'],
    ])('names %s by its kind', (_label, waitKind, expected) => {
      const reason: ActivityReasonWire = { kind: 'permission', since: NOW_MS - 12 * MINUTE_MS, waitKind };
      expect(formatActivityLine(lineInput({ state: 'permission', reason: { kind: 'permission', waitKind } }), NOW_MS)).toBe(expected);
      expect(formatActivityLine(lineInput({ state: 'permission', reason }), NOW_MS)).toBe(`${expected} for 12m`);
    });

    it('reads a kind this build does not know as an unknown wait', () => {
      const reason = { kind: 'permission', waitKind: 'plan' } as unknown as ActivityReasonWire;
      expect(formatActivityLine(lineInput({ state: 'permission', reason }), NOW_MS)).toBe('Waiting on you');
    });

    it('leaves the duration off below a minute', () => {
      expect(formatActivityLine(waitingInput('permission', MINUTE_MS - 1), NOW_MS)).toBe('Waiting on you');
    });

    it('shows whole minutes from exactly a minute', () => {
      expect(formatActivityLine(waitingInput('permission', MINUTE_MS), NOW_MS)).toBe('Waiting on you for 1m');
    });

    it('truncates 12m59s to 12m, where rounding would say 13m', () => {
      expect(formatActivityLine(waitingInput('permission', 12 * MINUTE_MS + 59_000), NOW_MS)).toBe('Waiting on you for 12m');
    });

    it('drops the duration when the surface already shows the wait (now is null)', () => {
      expect(formatActivityLine(waitingInput('permission', 12 * MINUTE_MS), null)).toBe('Waiting on you');
    });

    /**
     * A prompt arriving sets `state` without touching `reason`, so a session
     * that needs the user can still carry the turn's last reason - or an idle
     * one whose `since` is the idle wait, not the permission wait.
     */
    it.each<[string, ActivityReasonWire]>([
      ['a stale turn-active reason', { kind: 'turn-active' }],
      ['an idle reason with its own since', { kind: 'idle', since: NOW_MS - 30 * MINUTE_MS }],
    ])('keys on the state, not the reason, when it carries %s', (_label, reason) => {
      expect(formatActivityLine(lineInput({ state: 'permission', reason }), NOW_MS)).toBe('Waiting on you');
    });
  });

  describe('idle', () => {
    it('reads plainly with no wait on record', () => {
      expect(formatActivityLine(lineInput({ state: 'idle', reason: { kind: 'idle' } }), NOW_MS)).toBe('Idle');
    });

    it('leaves the duration off below a minute', () => {
      expect(formatActivityLine(waitingInput('idle', 59_000), NOW_MS)).toBe('Idle');
    });

    it('shows hours and minutes, truncating 65m30s to 1h 5m where rounding would say 1h 6m', () => {
      expect(formatActivityLine(waitingInput('idle', 65 * MINUTE_MS + 30_000), NOW_MS)).toBe('Idle for 1h 5m');
    });

    it('shows minutes alone under an hour', () => {
      expect(formatActivityLine(waitingInput('idle', 12 * MINUTE_MS), NOW_MS)).toBe('Idle for 12m');
    });

    it('drops the duration when now is null', () => {
      expect(formatActivityLine(waitingInput('idle', 65 * MINUTE_MS), null)).toBe('Idle');
    });

    it('ignores a permission reason\'s since while idle', () => {
      expect(formatActivityLine(lineInput({ state: 'idle', reason: { kind: 'permission', since: NOW_MS - 30 * MINUTE_MS } }), NOW_MS)).toBe(
        'Idle',
      );
    });
  });

  describe('thinking', () => {
    const thinking = (reason: ActivityReasonWire | null): ActivityLineInput => lineInput({ state: 'thinking', reason });

    it('names the tool that is running', () => {
      expect(formatActivityLine(thinking({ kind: 'tool', pendingCount: 1, currentTool: 'Bash' }), NOW_MS)).toBe('Running Bash');
    });

    it.each([
      [1, '1 tool in flight'],
      [3, '3 tools in flight'],
    ])('counts the tools in flight when none is named (%i)', (pendingCount, expected) => {
      expect(formatActivityLine(thinking({ kind: 'tool', pendingCount, currentTool: null }), NOW_MS)).toBe(expected);
    });

    it('treats an empty tool name as none', () => {
      expect(formatActivityLine(thinking({ kind: 'tool', pendingCount: 2, currentTool: '' }), NOW_MS)).toBe('2 tools in flight');
    });

    it.each([
      [1, '1 subagent active'],
      [2, '2 subagents active'],
    ])('counts subagents (depth %i)', (depth, expected) => {
      expect(formatActivityLine(thinking({ kind: 'subagent', depth }), NOW_MS)).toBe(expected);
    });

    it('names the background shells it can', () => {
      expect(formatActivityLine(thinking({ kind: 'background-shell', count: 1, ids: ['bash_1'] }), NOW_MS)).toBe('1 background shell (bash_1)');
      expect(formatActivityLine(thinking({ kind: 'background-shell', count: 2, ids: ['bash_1', 'bash_2'] }), NOW_MS)).toBe(
        '2 background shells (bash_1, bash_2)',
      );
    });

    it('leaves the parenthesis off when no shell is named', () => {
      expect(formatActivityLine(thinking({ kind: 'background-shell', count: 1, ids: [] }), NOW_MS)).toBe('1 background shell');
    });

    it.each<[string, ActivityReasonWire | null]>([
      ['a turn in flight', { kind: 'turn-active' }],
      ['no reason at all', null],
      ['a stale idle reason', { kind: 'idle' }],
      ['a stale permission reason', { kind: 'permission' }],
    ])('says "Thinking" for %s', (_label, reason) => {
      expect(formatActivityLine(thinking(reason), NOW_MS)).toBe('Thinking');
    });
  });
});
