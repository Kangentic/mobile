import { create } from 'zustand';
import type { TransportState } from '@kangentic/protocol';

interface ChannelState {
  transportState: TransportState;
  established: boolean;
  /**
   * Whether the channel has established at least once this launch. Lets
   * UI distinguish startup (connecting for the first time, narrated by
   * the empty states) from a REGRESSION of a working link (what the
   * connection banner warns about).
   */
  everEstablished: boolean;
  /**
   * Epoch ms the CURRENT secure session was established, null while there is
   * none. A board snapshot applied at or after it was read on this connection;
   * one from before is what the phone held while it was away, which can be
   * minutes stale after a background (the resume on open reads it so a push
   * tap never decides on the pre-pause row it cached).
   */
  establishedAt: number | null;
  rekeyCount: number;
  relayUrl: string | null;
  /** 'unknown' until the trust anchor has been checked at least once this launch. */
  pairedState: 'unknown' | 'unpaired' | 'paired';
}

interface ChannelActions {
  setTransportState: (state: TransportState) => void;
  markEstablished: () => void;
  noteRekey: () => void;
  setRelayUrl: (relayUrl: string) => void;
  setPairedState: (pairedState: ChannelState['pairedState']) => void;
  reset: () => void;
}

const initialState: ChannelState = {
  transportState: 'idle',
  established: false,
  everEstablished: false,
  establishedAt: null,
  rekeyCount: 0,
  relayUrl: null,
  pairedState: 'unknown',
};

/** Mirrors the active ChannelController's state for UI reads. Never persisted - a fresh connect always rebuilds this from scratch. */
export const useChannelStore = create<ChannelState & ChannelActions>((set, get) => ({
  ...initialState,
  setTransportState: (transportState) =>
    set({
      transportState,
      // Leaving 'connected' always drops session state (ChannelController's
      // reconnect model: transport resumes, crypto restarts).
      established: transportState === 'connected' ? get().established : false,
      establishedAt: transportState === 'connected' ? get().establishedAt : null,
    }),
  markEstablished: () =>
    set({
      established: true,
      everEstablished: true,
      establishedAt: Date.now(),
    }),
  // Counted from SessionManager.onRekey, NOT from markEstablished. A rekey
  // never re-fires onEstablished, and a transport drop clears `established`
  // before the next handshake, so an increment guarded on `established` here
  // could never fire at all - the gauge read 0 forever and looked like proof
  // that rekeys were not happening.
  noteRekey: () => set((state) => ({ rekeyCount: state.rekeyCount + 1 })),
  setRelayUrl: (relayUrl) => set({ relayUrl }),
  setPairedState: (pairedState) => set({ pairedState }),
  reset: () => set({ ...initialState, relayUrl: get().relayUrl, pairedState: get().pairedState }),
}));
