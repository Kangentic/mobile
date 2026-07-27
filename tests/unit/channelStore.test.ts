/**
 * channelStore's noteRekey: the ONLY observable that a Noise rekey ever
 * happened. The previous implementation incremented rekeyCount from
 * markEstablished, guarded on the session already being established - but
 * markEstablished only ever fires on the null-to-established transition, so
 * that guard could never pass, and the counter read 0 forever even while
 * periodic rekeys were happening (see the comment above noteRekey in
 * src/state/channelStore.ts, and commit c603987). noteRekey now increments
 * unconditionally and is wired to SessionManager.onRekey instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChannelStore } from '@/state/channelStore';

describe('channelStore', () => {
  beforeEach(() => {
    useChannelStore.getState().reset();
  });

  describe('noteRekey', () => {
    it('increments rekeyCount even while the channel is not established', () => {
      expect(useChannelStore.getState().established).toBe(false);
      expect(useChannelStore.getState().rekeyCount).toBe(0);

      useChannelStore.getState().noteRekey();

      expect(useChannelStore.getState().rekeyCount).toBe(1);
    });

    it('increments across multiple calls', () => {
      useChannelStore.getState().noteRekey();
      useChannelStore.getState().noteRekey();
      useChannelStore.getState().noteRekey();

      expect(useChannelStore.getState().rekeyCount).toBe(3);
    });

    it('increments independently of markEstablished (a rekey does not re-fire it)', () => {
      useChannelStore.getState().markEstablished();
      useChannelStore.getState().noteRekey();
      useChannelStore.getState().noteRekey();

      expect(useChannelStore.getState().established).toBe(true);
      expect(useChannelStore.getState().rekeyCount).toBe(2);
    });
  });

  describe('reset', () => {
    it('zeroes rekeyCount (a fresh connection starts its own count) while relayUrl and pairedState survive', () => {
      useChannelStore.getState().setRelayUrl('wss://relay.example.test');
      useChannelStore.getState().setPairedState('paired');
      useChannelStore.getState().noteRekey();
      useChannelStore.getState().noteRekey();
      expect(useChannelStore.getState().rekeyCount).toBe(2);

      useChannelStore.getState().reset();

      expect(useChannelStore.getState().rekeyCount).toBe(0);
      expect(useChannelStore.getState().relayUrl).toBe('wss://relay.example.test');
      expect(useChannelStore.getState().pairedState).toBe('paired');
    });
  });
});
