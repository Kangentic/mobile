import type { PairingQrPayload } from '@kangentic/protocol';
import { RelayTransport, deriveSlotId } from '@/channel';
import { DeviceIdentityManager } from './deviceIdentity';
import { PairingMachine, type PairingMachineState } from './pairingMachine';
import { TrustAnchorStore } from './trustAnchor';
import { usePairingStore } from '@/state/pairingStore';

const deviceIdentityManager = new DeviceIdentityManager();
const trustAnchorStore = new TrustAnchorStore();

let activeMachine: PairingMachine | null = null;
let activePayload: PairingQrPayload | null = null;

/**
 * A module-level singleton, deliberately outside Zustand: a live
 * PairingMachine (and the transport it owns) is not serializable UI state,
 * it is a stateful crypto object with a transport connection. The Zustand
 * pairingStore mirrors its `PairingMachineState` for screens to read;
 * this module is the only thing that ever calls its methods.
 */
export async function beginPairing(payload: PairingQrPayload, deviceName: string): Promise<void> {
  activeMachine?.reject();

  const identity = await deviceIdentityManager.getIdentity();
  const slotId = deriveSlotId({ kind: 'pairing', pairingToken: payload.pairingToken });
  const transport = new RelayTransport({ relayUrl: payload.relayAddress, slotId });

  const machine = new PairingMachine({ identity, payload, transport, deviceName });
  activeMachine = machine;
  activePayload = payload;
  machine.onStateChange((state: PairingMachineState) => {
    if (activeMachine === machine) usePairingStore.getState().setMachineState(state);
  });
  usePairingStore.getState().setMachineState(machine.getState());

  await machine.start();
}

/** Pins the desktop's static key (already known from the QR) as the trust anchor, then completes the ceremony. */
export async function confirmActivePairing(): Promise<void> {
  if (!activeMachine || !activePayload) throw new Error('No active pairing to confirm');
  // Only pin the anchor once we know the machine can actually confirm: a
  // timeout/error/reject may have raced the user's tap, and persisting the
  // desktop key for a ceremony that never completed would leave an orphan.
  const machine = activeMachine;
  if (machine.getState().status !== 'awaiting-sas') {
    throw new Error(`Cannot confirm pairing while state is "${machine.getState().status}"`);
  }
  await trustAnchorStore.save({
    desktopStaticPublicKey: activePayload.desktopStaticPublicKey,
    relayAddress: activePayload.relayAddress,
    pairedAt: new Date().toISOString(),
  });
  try {
    machine.confirm();
  } catch (error) {
    // Raced to a terminal state between the guard and confirm; roll the
    // anchor back so it never outlives a failed ceremony.
    await trustAnchorStore.clear();
    throw error;
  }
}

export function rejectActivePairing(): void {
  activeMachine?.reject();
}

export function resetActivePairing(): void {
  activeMachine = null;
  activePayload = null;
  usePairingStore.getState().reset();
}
