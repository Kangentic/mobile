import { describe, expect, it } from 'vitest';
import { resolveCurrentSessionId } from '../../src/screens/task/sessionResolution';

describe('resolveCurrentSessionId', () => {
  it('uses the param hint while the board has not located the task', () => {
    expect(
      resolveCurrentSessionId({ taskLocated: false, locatedSessionId: null, paramSessionId: 'sess-param' }),
    ).toBe('sess-param');
  });

  it('returns null when nothing is known yet', () => {
    expect(resolveCurrentSessionId({ taskLocated: false, locatedSessionId: null, paramSessionId: null })).toBeNull();
  });

  it('prefers the located session over a stale param once the task is located', () => {
    expect(
      resolveCurrentSessionId({ taskLocated: true, locatedSessionId: 'sess-current', paramSessionId: 'sess-dead' }),
    ).toBe('sess-current');
  });

  it('treats a located task with no session as authoritative null, ignoring the param', () => {
    expect(
      resolveCurrentSessionId({ taskLocated: true, locatedSessionId: null, paramSessionId: 'sess-dead' }),
    ).toBeNull();
  });

  it('follows the located session when no param was given', () => {
    expect(
      resolveCurrentSessionId({ taskLocated: true, locatedSessionId: 'sess-live', paramSessionId: null }),
    ).toBe('sess-live');
  });
});
