/**
 * scripts/lib/onlineEnvironment.mjs is the environment both Expo drift scripts run the
 * CLI in. ci.yml's required drift step sets EXPO_OFFLINE, and a shell or runner that
 * carried it into the daily live check would quietly make that check offline too.
 *
 * Tier: Unit.
 */
import { describe, expect, it } from 'vitest';

import { onlineEnvironment } from '../../scripts/lib/onlineEnvironment.mjs';

describe('onlineEnvironment', () => {
  it('removes EXPO_OFFLINE and keeps everything else', () => {
    const environment = onlineEnvironment({ EXPO_OFFLINE: '1', PATH: '/usr/bin', CI: 'true' });
    expect(environment).toEqual({ PATH: '/usr/bin', CI: 'true' });
  });

  it('does not change the environment it was given', () => {
    const base = { EXPO_OFFLINE: '1' };
    onlineEnvironment(base);
    expect(base).toEqual({ EXPO_OFFLINE: '1' });
  });
});
