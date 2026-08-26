import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, PROTOCOL_VERSION, randomBytes, type PairingQrPayload } from '@kangentic/protocol';
import { PairingMachine, type PairingMachineState } from '@/pairing/pairingMachine';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubPairingResponder } from '@/devsupport/stubDesktopPeer';

function futureIsoTimestamp(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

function waitForState(machine: PairingMachine, predicate: (state: PairingMachineState) => boolean): Promise<PairingMachineState> {
  const current = machine.getState();
  if (predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const unsubscribe = machine.onStateChange((state) => {
      if (predicate(state)) {
        unsubscribe();
        resolve(state);
      }
    });
  });
}

describe('PairingMachine', () => {
  it('reaches awaiting-sas with a SAS matching the desktop responder, then confirms to paired', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    const responder = new StubPairingResponder(desktopTransport, { desktopStatic, pairingToken });
    await desktopTransport.connect();

    const payload: PairingQrPayload = {
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: 'wss://relay.example.com',
      expiresAt: futureIsoTimestamp(600),
      protocolVersion: PROTOCOL_VERSION,
    };

    const machine = new PairingMachine({
      identity: phoneIdentity,
      payload,
      transport: phoneTransport,
      deviceName: 'test-phone',
    });

    void machine.start();
    const awaitingSas = await waitForState(machine, (state) => state.status === 'awaiting-sas' || state.status === 'error');
    expect(awaitingSas.status).toBe('awaiting-sas');
    if (awaitingSas.status !== 'awaiting-sas') throw new Error('unreachable');

    const desktopSas = responder.getSas();
    expect(desktopSas).not.toBeNull();
    expect(awaitingSas.sas.digits).toBe(desktopSas?.digits);

    expect(responder.isConfirmed()).toBe(false);
    machine.confirm();
    expect(machine.getState().status).toBe('paired');
    // The loopback delivers on a microtask, and confirm() closes the transport
    // immediately after sending. Yielding here also pins the ORDERING: the
    // frame must still reach the peer despite that close.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The half that actually matters, and the half nobody asserted: the phone
    // saying "paired" to itself is not pairing. The desktop enrolls the device
    // only when the sealed confirm frame reaches it and opens. Without this,
    // confirm() could set local state and close the socket - which it did -
    // and every test here still passed while the real desktop sat on
    // "Waiting for your phone..." until it timed out.
    expect(responder.isConfirmed()).toBe(true);
  });

  it('surfaces desktop-absent when the responder holds the wrong token (opaque, no oracle)', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const realToken = randomBytes(32);
    const wrongTokenTheDesktopActuallyHas = randomBytes(32);
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    new StubPairingResponder(desktopTransport, { desktopStatic, pairingToken: wrongTokenTheDesktopActuallyHas });
    await desktopTransport.connect();

    const payload: PairingQrPayload = {
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken: realToken,
      relayAddress: 'wss://relay.example.com',
      expiresAt: futureIsoTimestamp(600),
      protocolVersion: PROTOCOL_VERSION,
    };

    const machine = new PairingMachine({
      identity: phoneIdentity,
      payload,
      transport: phoneTransport,
      deviceName: 'test-phone',
      timeoutMs: 2_000,
    });

    void machine.start();
    const finalState = await waitForState(machine, (state) => state.status === 'error');
    expect(finalState.status).toBe('error');
    if (finalState.status !== 'error') throw new Error('unreachable');
    expect(finalState.errorKind).toBe('desktop-absent');
  });

  /**
   * StubPairingResponderOptions.protocolVersion is bound into the Noise
   * prologue the same way the initiator's payload.protocolVersion is (see
   * pairingMachine.ts's `createPairingInitiatorHandshake({ protocolVersion:
   * this.payload.protocolVersion })`). A mismatched prologue must fail the
   * handshake exactly like a mismatched pre-shared key does above - if the
   * option were silently dropped (a typo in the spread that builds it), the
   * two sides would bind DIFFERENT prologues and this test would still pass
   * for the wrong reason, so it also proves the MATCHING case succeeds.
   */
  it('fails the handshake when the responder is bound to a different protocol version than the payload', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    new StubPairingResponder(desktopTransport, { desktopStatic, pairingToken, protocolVersion: '1' });
    await desktopTransport.connect();

    const payload: PairingQrPayload = {
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: 'wss://relay.example.com',
      expiresAt: futureIsoTimestamp(600),
      // Deliberately NOT '1': the initiator's own protocol version, bound
      // into ITS prologue.
      protocolVersion: '2',
    };

    const machine = new PairingMachine({
      identity: phoneIdentity,
      payload,
      transport: phoneTransport,
      deviceName: 'test-phone',
      timeoutMs: 2_000,
    });

    void machine.start();
    const finalState = await waitForState(machine, (state) => state.status === 'error');
    expect(finalState.status).toBe('error');
    if (finalState.status !== 'error') throw new Error('unreachable');
    expect(finalState.errorKind).toBe('desktop-absent');
  });

  it('reaches awaiting-sas when both sides bind the SAME explicit protocol version to the responder', async () => {
    // The non-vacuity half: a StubPairingResponder given a MATCHING
    // protocolVersion must still succeed, or the mismatch case above could
    // be passing merely because any explicit protocolVersion breaks the
    // handshake.
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    new StubPairingResponder(desktopTransport, { desktopStatic, pairingToken, protocolVersion: '7' });
    await desktopTransport.connect();

    const payload: PairingQrPayload = {
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: 'wss://relay.example.com',
      expiresAt: futureIsoTimestamp(600),
      protocolVersion: '7',
    };

    const machine = new PairingMachine({
      identity: phoneIdentity,
      payload,
      transport: phoneTransport,
      deviceName: 'test-phone',
      timeoutMs: 2_000,
    });

    void machine.start();
    const finalState = await waitForState(machine, (state) => state.status === 'awaiting-sas' || state.status === 'error');
    expect(finalState.status).toBe('awaiting-sas');
  });

  it('times out when no desktop ever responds', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);
    const [phoneTransport] = createLoopbackPair();

    const payload: PairingQrPayload = {
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: 'wss://relay.example.com',
      expiresAt: futureIsoTimestamp(600),
      protocolVersion: PROTOCOL_VERSION,
    };

    const machine = new PairingMachine({
      identity: phoneIdentity,
      payload,
      transport: phoneTransport,
      deviceName: 'test-phone',
      timeoutMs: 50,
    });

    void machine.start();
    const finalState = await waitForState(machine, (state) => state.status === 'error');
    expect(finalState.status).toBe('error');
    if (finalState.status !== 'error') throw new Error('unreachable');
    expect(finalState.errorKind).toBe('timeout');
  });

  it('fails when the pairing socket drops while the user is reading the SAS', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    new StubPairingResponder(desktopTransport, { desktopStatic, pairingToken });
    await desktopTransport.connect();

    const payload: PairingQrPayload = {
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: 'wss://relay.example.com',
      expiresAt: futureIsoTimestamp(600),
      protocolVersion: PROTOCOL_VERSION,
    };

    const machine = new PairingMachine({ identity: phoneIdentity, payload, transport: phoneTransport, deviceName: 'test-phone' });
    void machine.start();
    await waitForState(machine, (state) => state.status === 'awaiting-sas');

    // A real RelayTransport reconnects on a dropped socket, so the ceremony
    // used to sail on: confirm() sealed a frame into a slot the relay had
    // already emptied, and the phone reported success while the desktop never
    // enrolled it. Comparing six digits takes long enough for this to happen.
    phoneTransport.simulateReconnect();

    const finalState = machine.getState();
    expect(finalState.status).toBe('error');
    if (finalState.status !== 'error') throw new Error('unreachable');
    expect(finalState.errorKind).toBe('desktop-absent');
    // And it must be unconfirmable afterwards, not merely flagged.
    expect(() => machine.confirm()).toThrow();
  });

  it('lets the user reject after seeing a mismatched SAS', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const pairingToken = randomBytes(32);
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    new StubPairingResponder(desktopTransport, { desktopStatic, pairingToken });
    await desktopTransport.connect();

    const payload: PairingQrPayload = {
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: 'wss://relay.example.com',
      expiresAt: futureIsoTimestamp(600),
      protocolVersion: PROTOCOL_VERSION,
    };

    const machine = new PairingMachine({ identity: phoneIdentity, payload, transport: phoneTransport, deviceName: 'test-phone' });
    void machine.start();
    await waitForState(machine, (state) => state.status === 'awaiting-sas');

    machine.reject();
    expect(machine.getState().status).toBe('rejected');
  });
});
