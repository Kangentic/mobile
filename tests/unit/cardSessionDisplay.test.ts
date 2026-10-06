import { describe, expect, it } from 'vitest';
import { SPAWN_LABEL_MAX_LENGTH, cardSessionDisplay } from '@/components/board/cardSessionDisplay';
import type { RespawnInFlight } from '@/state/activityStore';

function respawnWith(label: string | null): RespawnInFlight {
  return { label, reportedAt: 0, endedSessionId: 'session-ended' };
}

/**
 * The desktop's precedence (kangentic `getTaskProgress`, task-progress.ts):
 * a step label wins only when no session runs, then the session's status
 * decides, and a running session with nothing reported is still running.
 */
describe('cardSessionDisplay', () => {
  it('reads a running session, or one whose status was never reported, as running', () => {
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: 'running', respawn: null })).toEqual({ kind: 'running' });
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: null, respawn: null })).toEqual({ kind: 'running' });
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: undefined, respawn: null })).toEqual({ kind: 'running' });
  });

  it('maps the desktop\'s queued, suspended and exited statuses to their own states', () => {
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: 'queued', respawn: null })).toEqual({ kind: 'queued' });
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: 'suspended', respawn: null })).toEqual({ kind: 'suspended' });
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: 'exited', respawn: null })).toEqual({ kind: 'exited' });
  });

  it('is none for a task with no session and nothing in flight', () => {
    expect(cardSessionDisplay({ hasSession: false, sessionStatus: undefined, respawn: null })).toEqual({ kind: 'none' });
  });

  /**
   * The phone's only step label rides the session-ended push, so a respawn in
   * flight means the session is gone. It must win over whatever status the
   * ended session's entry still carries, exactly as the desktop's label wins
   * over a missing or suspended session.
   */
  it('shows a respawn\'s step, even over the ended session\'s stale status', () => {
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: 'running', respawn: respawnWith('Switching model...') })).toEqual({
      kind: 'preparing',
      label: 'Switching model...',
    });
    expect(cardSessionDisplay({ hasSession: false, sessionStatus: undefined, respawn: respawnWith('Starting new session...') })).toEqual({
      kind: 'preparing',
      label: 'Starting new session...',
    });
  });

  it('reads an end with no step as an ended session, never a guessed step', () => {
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: 'running', respawn: respawnWith(null) })).toEqual({ kind: 'exited' });
    expect(cardSessionDisplay({ hasSession: true, sessionStatus: 'running', respawn: respawnWith('   ') })).toEqual({ kind: 'exited' });
  });

  it('caps the desktop\'s step text, which is untrusted display data', () => {
    const display = cardSessionDisplay({ hasSession: false, sessionStatus: undefined, respawn: respawnWith('x'.repeat(500)) });
    expect(display).toEqual({ kind: 'preparing', label: 'x'.repeat(SPAWN_LABEL_MAX_LENGTH) });
  });
});
