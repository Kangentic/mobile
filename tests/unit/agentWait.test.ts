/**
 * The phone's port of the desktop's agent-wait.ts: the STATE opens a wait, the
 * reason only names it, and a wait with no kind the app knows reads as unknown,
 * which draws the question's bubble.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityReasonWire } from '@kangentic/protocol';
import { agentWaitKind, waitMarkKind } from '@/lib/agentWait';

describe('agentWaitKind', () => {
  it('is null unless the state is a permission wait', () => {
    expect(agentWaitKind('thinking', { kind: 'permission', waitKind: 'question' })).toBeNull();
    expect(agentWaitKind('idle', { kind: 'permission', waitKind: 'approval' })).toBeNull();
    expect(agentWaitKind(null, null)).toBeNull();
    expect(agentWaitKind(undefined, undefined)).toBeNull();
  });

  it('names the kind the permission reason reports', () => {
    expect(agentWaitKind('permission', { kind: 'permission', since: 1, waitKind: 'question' })).toBe('question');
    expect(agentWaitKind('permission', { kind: 'permission', since: 1, waitKind: 'approval' })).toBe('approval');
  });

  it('reads a wait with no reported kind as unknown', () => {
    expect(agentWaitKind('permission', { kind: 'permission', since: 1 })).toBe('unknown');
    expect(agentWaitKind('permission', null)).toBe('unknown');
  });

  it('reads a reason that lags the state (a prompt event writes no reason) as unknown', () => {
    expect(agentWaitKind('permission', { kind: 'turn-active' })).toBe('unknown');
    expect(agentWaitKind('permission', { kind: 'idle', since: 1 })).toBe('unknown');
  });

  /**
   * The feed keeps the RAW event (isBridgeEvent only validates it), so a kind a
   * newer desktop adds reaches the store unfiltered. It must read as unknown,
   * the way the protocol's own parsers drop it, never be passed through.
   */
  it('reads a kind this build does not know as unknown', () => {
    const newerReason = { kind: 'permission', since: 1, waitKind: 'plan' } as unknown as ActivityReasonWire;
    expect(agentWaitKind('permission', newerReason)).toBe('unknown');
  });
});

describe('waitMarkKind', () => {
  it('draws the bubble for a question and for an unknown wait, the shield for an approval', () => {
    expect(waitMarkKind('question')).toBe('question');
    expect(waitMarkKind('unknown')).toBe('question');
    expect(waitMarkKind('approval')).toBe('approval');
  });
});
