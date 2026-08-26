import { PROTOCOL_VERSION } from '@kangentic/protocol';
import { beginPairing } from '@/pairing/activePairing';
import { TrustAnchorStore } from '@/pairing/trustAnchor';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubPairingResponder } from '@/devsupport/stubDesktopPeer';
import { usePairingStore } from '@/state/pairingStore';
import { DEMO_DESKTOP_STATIC, DEMO_PAIRING_TOKEN, demoPairingPayload } from './demoIdentity';

/**
 * The demo half of the pairing ceremony.
 *
 * This is a REAL Noise IKpsk0 pairing, not a simulation of one: the same
 * `PairingMachine` the camera path uses, running against the same
 * `StubPairingResponder` the unit tests use, over an in-process loopback
 * transport. The SAS digits on the confirm screen are derived from a genuine
 * transcript hash, and the trust anchor written on confirm is a genuine anchor.
 * The only thing that differs from a real pairing is who is on the other end.
 *
 * Doing it for real rather than faking the screens is a deliberate choice.
 * Fabricating SAS digits would mean shipping a security surface that verifies
 * nothing, which is a bad thing to hand a reviewer who is assessing whether the
 * app is complete, and a worse thing to leave in the codebase afterwards.
 */

const trustAnchorStore = new TrustAnchorStore();

/**
 * The responder for the ceremony currently in flight.
 *
 * Module-level for the same reason `activePairing` keeps its machine there: it
 * owns a transport and is not serialisable UI state. At most one ceremony runs
 * at a time, so a second start disposes the first.
 */
let activeResponder: StubPairingResponder | null = null;

/**
 * Test-only: the responder for the ceremony currently in flight, mirroring
 * mockDesktop's `staticSessionSeedTranscriptForTest` convention. Lets a test
 * assert the phone's displayed SAS against the responder's OWN independently
 * derived one, rather than merely asserting the phone's digits look like a
 * SAS (a hardcoded placeholder would also pass a shape-only check).
 */
export function activeResponderForTest(): StubPairingResponder | null {
  return activeResponder;
}

/** Raised when the demo is entered on a phone that is already paired to a real desktop. */
export class AlreadyPairedError extends Error {
  constructor() {
    super('This phone is already paired. Unpair first to use the demo.');
    this.name = 'AlreadyPairedError';
  }
}

/** Raised when the demo is entered while a REAL pairing ceremony is mid-flight. */
export class PairingInProgressError extends Error {
  constructor() {
    super('A pairing is already in progress. Finish or cancel it first.');
    this.name = 'PairingInProgressError';
  }
}

/**
 * Runs the demo pairing ceremony to `awaiting-sas`, leaving the confirm screen
 * to complete it exactly as it completes a real one.
 *
 * Refuses when a trust anchor already exists. The real pairing flow deliberately
 * allows re-pairing over an existing anchor, but the demo must not: a stray
 * scan or deep link would otherwise drop someone's working desktop pairing and
 * replace it with fixtures, which is a destructive outcome from an input the
 * user may not have understood. Re-entering the demo over an existing DEMO
 * pairing is refused by the same guard, and is harmless to refuse since the
 * demo is already running.
 */
export async function beginDemoPairing(deviceName: string): Promise<void> {
  if (await trustAnchorStore.load()) throw new AlreadyPairedError();

  // Refuse to clobber a REAL ceremony mid-flight: beginPairing() rejects any
  // active machine before starting a new one, so a demo deep link arriving
  // while the user is on the confirm screen of a genuine pairing would swap
  // the SAS digits out from under them with no visible transition. A live
  // demo ceremony is discriminated by activeResponder: the demo is the only
  // pairing that has one, and re-entering the demo over itself is harmless
  // (it disposes its own responder below).
  const inFlightStatus = usePairingStore.getState().machineState?.status;
  const realCeremonyInFlight =
    activeResponder === null &&
    (inFlightStatus === 'connecting' || inFlightStatus === 'handshaking' || inFlightStatus === 'awaiting-sas');
  if (realCeremonyInFlight) throw new PairingInProgressError();

  activeResponder?.dispose();
  activeResponder = null;

  const [phoneTransport, desktopTransport] = createLoopbackPair();

  // The desktop end has to be up BEFORE the phone sends message 1.
  // LoopbackTransport re-checks the peer's state when its delivery microtask
  // drains and silently drops the frame if the peer is not connected, so a
  // responder brought up afterwards would never see the handshake and the
  // ceremony would sit at 'connecting' until the machine's 20s timeout.
  await desktopTransport.connect();

  const responder = new StubPairingResponder(desktopTransport, {
    desktopStatic: DEMO_DESKTOP_STATIC,
    pairingToken: DEMO_PAIRING_TOKEN,
    // Both sides bind the same version into the Noise prologue. Today this is
    // technically redundant: the initiator reads the version off the payload,
    // and demoPairingPayload() sets that from the same build-time
    // PROTOCOL_VERSION constant, so the responder's default would match too.
    // It is passed explicitly anyway because the coincidence is the fragile
    // part: if the payload's version ever diverges from the responder default,
    // the two prologues differ and the handshake fails to authenticate as an
    // opaque 'handshake-failed'. tests/unit/pairingMachine.test.ts pins the
    // wiring in both directions.
    protocolVersion: PROTOCOL_VERSION,
  });
  activeResponder = responder;

  // The machine closes the phone transport on teardown, and LoopbackTransport
  // propagates a close to its peer, so this fires on every exit path the
  // ceremony has: confirm, reject, timeout, and unmount.
  desktopTransport.onStateChange((state) => {
    if (state !== 'closed') return;
    if (activeResponder !== responder) return;
    responder.dispose();
    activeResponder = null;
  });

  try {
    await beginPairing(demoPairingPayload(), deviceName, { transport: phoneTransport });
  } catch (error) {
    // beginPairing can reject before a PairingMachine exists to own the
    // teardown (a SecureStore failure loading the device identity, say), and
    // then nothing else would ever close this transport. Closing it fires the
    // state handler above, which disposes the responder.
    desktopTransport.close();
    throw error;
  }
}
