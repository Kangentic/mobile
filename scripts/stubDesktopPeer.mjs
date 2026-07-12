#!/usr/bin/env node
/**
 * A desktop counterpart to kangentic-mobile's pairing + secure channel
 * client, run over a REAL WebSocket against a locally running
 * kangentic-relay. This is a manual integration smoke, not part of the
 * automated test suite (that lives in tests/unit/, driven by the same
 * @kangentic/protocol code over an in-memory loopback transport).
 *
 * Usage:
 *   1. Run a local kangentic-relay (see that repo's README), e.g. on
 *      ws://127.0.0.1:8080.
 *   2. node scripts/stubDesktopPeer.mjs --relay ws://127.0.0.1:8080
 *   3. Scan the printed kangentic-pair:// URI with the app, or paste it into
 *      the "paste pairing link" fallback (the camera can't see a terminal).
 *   4. Confirm the SAS shown here matches the phone's screen, then answer
 *      the prompt. On confirm, this script opens a second connection for the
 *      ongoing session and exchanges heartbeats.
 *
 * Because @kangentic/protocol is pure TypeScript on @noble/*, this script
 * runs the EXACT same handshake code the phone runs on Hermes - it is a
 * faithful desktop stand-in, not a mock.
 */
import readline from 'node:readline/promises';
import {
  bytesToHex,
  createKKHandshake,
  createPairingResponderHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  deriveShortAuthenticationString,
  encodeMessage,
  encodePairingQrPayload,
  FrameTag,
  generateX25519KeyPair,
  PROTOCOL_VERSION,
  randomBytes,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
} from '@kangentic/protocol';

function parseArgs(argv) {
  const relayIndex = argv.indexOf('--relay');
  const relayUrl = relayIndex >= 0 ? argv[relayIndex + 1] : 'ws://127.0.0.1:8080';
  return { relayUrl };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => resolve(socket);
    socket.onerror = (event) => reject(new Error(`WebSocket error connecting to ${url}: ${event.message ?? 'unknown error'}`));
  });
}

function onFrame(socket, listener) {
  socket.onmessage = (event) => {
    const data = event.data;
    const frame = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(0);
    listener(frame);
  };
}

async function runPairing(relayUrl, desktopStatic, pairingToken) {
  const slotId = bytesToHex(pairingToken);
  const socket = await connect(`${relayUrl}?slot=${slotId}`);
  const handshake = createPairingResponderHandshake({ localStatic: desktopStatic, pairingToken });

  return new Promise((resolve, reject) => {
    onFrame(socket, (frame) => {
      try {
        handshake.readMessage(frame);
      } catch (error) {
        reject(new Error(`Pairing handshake failed to authenticate: ${error.message}`));
        return;
      }
      const { message } = handshake.writeMessage(new Uint8Array(0));
      socket.send(message.slice().buffer);

      const phoneStaticPublicKey = handshake.getRemoteStaticKey();
      const sas = deriveShortAuthenticationString(handshake.getHandshakeHash());
      resolve({ phoneStaticPublicKey, sas, socket });
    });
  });
}

function runSession(relayUrl, desktopStatic, phoneStaticPublicKey) {
  return connect(`${relayUrl}?slot=${bytesToHex(desktopStatic.publicKey)}`).then((socket) => {
    let streams = null;

    function beginHandshake() {
      const handshake = createKKHandshake({ initiator: true, localStatic: desktopStatic, remoteStatic: phoneStaticPublicKey });
      const { message } = handshake.writeMessage(new Uint8Array(0));
      socket.send(wrapSessionFrame(SessionFrameKind.Handshake, message).slice().buffer);

      onFrame(socket, (frame) => {
        const { kind, payload } = unwrapSessionFrame(frame);
        if (kind === SessionFrameKind.Handshake) {
          const result = handshake.readMessage(payload);
          if (!result.split) return;
          streams = deriveSecretstreamPair(handshake.getChainingKey(), true);
          console.log('[session] established');
          return;
        }
        if (!streams) return;
        const opened = streams.receive.open(payload);
        if (opened.tag === FrameTag.Final) {
          console.log('[session] remote closed');
          return;
        }
        const message = decodeMessage(opened.plaintext);
        console.log('[session] received:', message);
      });
    }

    function send(message) {
      if (!streams) throw new Error('session not established yet');
      const frame = streams.send.seal(encodeMessage(message));
      socket.send(wrapSessionFrame(SessionFrameKind.Application, frame).slice().buffer);
    }

    beginHandshake();
    return { send, socket };
  });
}

async function main() {
  const { relayUrl } = parseArgs(process.argv.slice(2));
  const desktopStatic = generateX25519KeyPair();
  const pairingToken = randomBytes(32);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const qrUri = encodePairingQrPayload({
    desktopStaticPublicKey: desktopStatic.publicKey,
    pairingToken,
    relayAddress: relayUrl,
    expiresAt,
    protocolVersion: PROTOCOL_VERSION,
  });

  console.log(`Relay: ${relayUrl}`);
  console.log(`Pairing URI (paste into the app's "paste pairing link" field):\n${qrUri}\n`);
  console.log('Waiting for the phone to connect...');

  const { phoneStaticPublicKey, sas } = await runPairing(relayUrl, desktopStatic, pairingToken);
  console.log(`\nSAS - confirm this matches the phone's screen:`);
  console.log(`  digits: ${sas.digits}`);
  console.log(`  emoji:  ${sas.emoji.join(' ')}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nDoes the SAS match? [y/N] ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Not confirmed - exiting.');
    process.exit(1);
  }

  console.log(`\nPaired. Phone static key: ${bytesToHex(phoneStaticPublicKey)}`);
  console.log('Opening the ongoing session and sending a heartbeat every 5s (Ctrl+C to stop)...\n');

  const session = await runSession(relayUrl, desktopStatic, phoneStaticPublicKey);
  setInterval(() => {
    try {
      session.send({ type: 'heartbeat' });
      console.log('[session] sent heartbeat');
    } catch (error) {
      console.log(`[session] heartbeat send skipped: ${error.message}`);
    }
  }, 5_000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
