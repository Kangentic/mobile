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
