import { create } from 'zustand';
import type { TransportState } from '@kangentic/protocol';

interface ChannelState {
  transportState: TransportState;
  established: boolean;
  rekeyCount: number;
  relayUrl: string | null;
}

interface ChannelActions {
  setTransportState: (state: TransportState) => void;
  markEstablished: () => void;
  setRelayUrl: (relayUrl: string) => void;
  reset: () => void;
}

const initialState: ChannelState = {
  transportState: 'idle',
  established: false,
  rekeyCount: 0,
  relayUrl: null,
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
  markEstablished: () => set((state) => ({ established: true, rekeyCount: state.established ? state.rekeyCount + 1 : state.rekeyCount })),
  setRelayUrl: (relayUrl) => set({ relayUrl }),
  reset: () => set({ ...initialState, relayUrl: get().relayUrl }),
}));
