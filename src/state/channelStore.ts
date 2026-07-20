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
  rekeyCount: number;
  relayUrl: string | null;
  /** 'unknown' until the trust anchor has been checked at least once this launch. */
  pairedState: 'unknown' | 'unpaired' | 'paired';
}

interface ChannelActions {
  setTransportState: (state: TransportState) => void;
  markEstablished: () => void;
  setRelayUrl: (relayUrl: string) => void;
  setPairedState: (pairedState: ChannelState['pairedState']) => void;
  reset: () => void;
}

const initialState: ChannelState = {
  transportState: 'idle',
  established: false,
  everEstablished: false,
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
    }),
  markEstablished: () =>
    set((state) => ({
      established: true,
      everEstablished: true,
      rekeyCount: state.established ? state.rekeyCount + 1 : state.rekeyCount,
    })),
  setRelayUrl: (relayUrl) => set({ relayUrl }),
  setPairedState: (pairedState) => set({ pairedState }),
  reset: () => set({ ...initialState, relayUrl: get().relayUrl, pairedState: get().pairedState }),
}));
