import type { PairingQrPayload, Transport } from '@kangentic/protocol';
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
export interface BeginPairingOptions {
  /**
   * Runs the ceremony over this transport instead of dialing the payload's
   * relay. The ONLY caller is `@/demo/demoPairing`, which supplies a loopback
   * pair so the reviewer/demo code can pair against an in-process peer with no
   * relay and no network (see `src/demo/demoIdentity.ts` for why that exists).
   *
   * Absent, this function behaves exactly as it did before the option existed:
   * derive the slot, dial the relay. The injection point mirrors the one
   * `ChannelController` already accepts for the same purpose, rather than
   * introducing a new pattern.
   */
  transport?: Transport;
}

export async function beginPairing(payload: PairingQrPayload, deviceName: string, options: BeginPairingOptions = {}): Promise<void> {
  activeMachine?.reject();

  const identity = await deviceIdentityManager.getIdentity();
  // No slot is derived for an injected transport: a slot is a relay rendezvous
  // label, and there is no relay in that path. Deriving one anyway would be
  // dead work that reads as if the demo touches relay routing.
  const transport =
    options.transport ?? new RelayTransport({ relayUrl: payload.relayAddress, slotId: deriveSlotId({ kind: 'pairing', pairingToken: payload.pairingToken }) });

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
