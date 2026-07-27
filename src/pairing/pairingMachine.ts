import {
  createPairingInitiatorHandshake,
  deriveShortAuthenticationString,
  sealPairingConfirm,
  type HandshakeReadResult,
  type HandshakeState,
  type PairingQrPayload,
  type ShortAuthenticationString,
  type Transport,
  type X25519KeyPair,
} from '@kangentic/protocol';

export type PairingErrorKind = 'relay-unreachable' | 'desktop-absent' | 'handshake-failed' | 'timeout';

export type PairingMachineState =
  | { status: 'connecting' }
  | { status: 'handshaking' }
  | { status: 'awaiting-sas'; sas: ShortAuthenticationString }
  | { status: 'paired' }
  | { status: 'rejected' }
  | { status: 'error'; errorKind: PairingErrorKind; message: string };

export type Unsubscribe = () => void;

export interface PairingMachineOptions {
  identity: X25519KeyPair;
  payload: PairingQrPayload;
  transport: Transport;
  /** Sent as the (unauthenticated-but-encrypted) message 1 payload, purely informational. Never a command. */
  deviceName: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Drives the phone's side of the Noise IKpsk0 pairing ceremony: connect the
 * transport, send message 1 (identity + device name, PSK-authenticated by
 * the QR token), read the desktop's (empty) reply, and derive the SAS from
 * the completed transcript hash. The desktop's reply carries no roster
 * blob - it signs the phone into its own local roster on SAS confirm - so
 * this machine's trust anchor is just the desktop's static public key
 * already known from the QR (see docs/security.md).
 *
 * A wrong token, a tampered message, and a mismatched protocol-version
 * prologue all collapse to one opaque `handshake-failed` state:
 * distinguishing them would hand an attacker a usable oracle, and the
 * single-use pairing token already gates guessing to one online attempt.
 */
export class PairingMachine {
  private readonly identity: X25519KeyPair;
  private readonly payload: PairingQrPayload;
  private readonly transport: Transport;
  private readonly deviceName: string;
  private readonly timeoutMs: number;

  private handshake: HandshakeState | null = null;
  /** The transport keys the completed handshake produced; the confirm frame is sealed under index 0 (initiator to responder). */
  private transportKeys: NonNullable<HandshakeReadResult['split']> | null = null;
  private state: PairingMachineState = { status: 'connecting' };
  private readonly listeners = new Set<(state: PairingMachineState) => void>();
  private unsubscribeFrame: Unsubscribe | null = null;
  private unsubscribeTransportState: Unsubscribe | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private settled = false;

  constructor(options: PairingMachineOptions) {
    this.identity = options.identity;
    this.payload = options.payload;
    this.transport = options.transport;
    this.deviceName = options.deviceName;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  getState(): PairingMachineState {
    return this.state;
  }

  onStateChange(listener: (state: PairingMachineState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.setState({ status: 'connecting' });
    this.armTimeout();
    this.unsubscribeTransportState = this.transport.onStateChange((transportState) => {
      if (transportState === 'closed' && !this.settled) {
        this.fail('desktop-absent', 'The relay connection closed before pairing completed.');
      }
    });
    this.unsubscribeFrame = this.transport.onFrame((frame) => this.onFrame(frame));

    try {
      await this.transport.connect();
    } catch (error) {
      this.fail('relay-unreachable', messageOf(error, 'Failed to connect to the relay.'));
      return;
    }
    if (this.settled) return;

    this.setState({ status: 'handshaking' });
    this.handshake = createPairingInitiatorHandshake({
      localStatic: this.identity,
      remoteStatic: this.payload.desktopStaticPublicKey,
      pairingToken: this.payload.pairingToken,
      protocolVersion: this.payload.protocolVersion,
    });

    let message1: Uint8Array;
    try {
      message1 = this.handshake.writeMessage(new TextEncoder().encode(this.deviceName)).message;
    } catch {
      this.fail('handshake-failed', 'Failed to start the pairing handshake.');
      return;
    }

    try {
      this.transport.send(message1);
    } catch (error) {
      this.fail('relay-unreachable', messageOf(error, 'Failed to send the pairing handshake to the relay.'));
    }
  }

  /**
   * Called once the user confirms both screens show the same SAS. The caller
   * is responsible for pinning the trust anchor first.
   *
   * Sends the pairing-confirm frame, which is what tells the desktop to
   * enroll this phone. Without it the desktop sits on "Waiting for your
   * phone..." until its own timer expires and never adds the device, while
   * the phone believes it is paired - a ceremony that completes on exactly
   * one side. There is no reject frame by design: backing out closes the
   * transport, and the desktop reads close-without-confirm as the rejection.
   */
  confirm(): void {
    if (this.state.status !== 'awaiting-sas' || this.settled || !this.transportKeys) {
      throw new Error(`Cannot confirm pairing while state is "${this.state.status}"`);
    }
    try {
      this.transport.send(sealPairingConfirm(this.transportKeys[0]));
    } catch (error) {
      const reason = messageOf(error, 'Failed to send the pairing confirmation to the relay.');
      this.fail('relay-unreachable', reason);
      // Rethrow: confirmActivePairing pinned the trust anchor before calling
      // this, and only a throw triggers its rollback. Swallowing here would
      // leave the phone anchored to a desktop that never enrolled it.
      throw new Error(reason);
    }
    this.settled = true;
    this.setState({ status: 'paired' });
    this.teardown();
  }

  /** Called if the user reports the SAS codes do not match, or cancels before that point. */
  reject(): void {
    if (this.settled) return;
    this.settled = true;
    this.setState({ status: 'rejected' });
    this.teardown();
  }

  private onFrame(frame: Uint8Array): void {
    if (this.settled || !this.handshake || this.state.status !== 'handshaking') return;
    let readResult: HandshakeReadResult;
    try {
      readResult = this.handshake.readMessage(frame);
    } catch {
      this.fail('handshake-failed', 'Pairing failed to authenticate. Rescan the code and try again.');
      return;
    }
    if (!readResult.split) {
      // IKpsk0 is exactly two messages, so reading message 2 always splits.
      this.fail('handshake-failed', 'Pairing failed to authenticate. Rescan the code and try again.');
      return;
    }
    // Held for confirm(): the desktop's AEAD open of the confirm frame IS its
    // check that both sides ran the same transcript, so these keys are the
    // only thing that can produce a frame it will accept.
    this.transportKeys = readResult.split;
    const sas = deriveShortAuthenticationString(this.handshake.getHandshakeHash());
    this.clearTimeout();
    this.setState({ status: 'awaiting-sas', sas });
  }

  private armTimeout(): void {
    this.clearTimeout();
    this.timeoutHandle = setTimeout(() => {
      this.fail('timeout', 'Pairing timed out. Rescan the code and try again.');
    }, this.timeoutMs);
  }

  private clearTimeout(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  private fail(errorKind: PairingErrorKind, message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.setState({ status: 'error', errorKind, message });
    this.teardown();
  }

  private setState(state: PairingMachineState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private teardown(): void {
    this.clearTimeout();
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.unsubscribeTransportState?.();
    this.unsubscribeTransportState = null;
    this.handshake = null;
    this.transport.close();
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
