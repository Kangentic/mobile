import { create } from 'zustand';
import type { PairingMachineState } from '@/pairing/pairingMachine';

interface PairingState {
  machineState: PairingMachineState | null;
}

interface PairingActions {
  setMachineState: (state: PairingMachineState) => void;
  reset: () => void;
}

/**
 * Mirrors the active PairingMachine's state for the pairing screens to
 * read. Never persisted (secure-storage.md): pairing material only ever
 * lives here in memory, and only the final trust anchor - written directly
 * to expo-secure-store by TrustAnchorStore - survives past this ceremony.
 */
export const usePairingStore = create<PairingState & PairingActions>((set) => ({
  machineState: null,
  setMachineState: (machineState) => set({ machineState }),
  reset: () => set({ machineState: null }),
}));

export function selectIsPaired(): boolean {
  return usePairingStore.getState().machineState?.status === 'paired';
}
