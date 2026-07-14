#!/usr/bin/env node
/**
 * A desktop counterpart to Kangentic Mobile's pairing + secure channel
 * client, run over a REAL WebSocket against a locally running
 * relay. This is a manual integration smoke, not part of the
 * automated test suite (that lives in tests/unit/, driven by the same
 * @kangentic/protocol code over an in-memory loopback transport).
 *
 * Usage:
 *   1. Run a local relay (see that repo's README), e.g. on
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bytesToHex,
  createKKHandshake,
  createPairingResponderHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  deriveSessionSlotId,
  deriveShortAuthenticationString,
  encodeMessage,
  encodePairingQrPayload,
  FrameTag,
  generateX25519KeyPair,
  hexToBytes,
  PROTOCOL_VERSION,
  randomBytes,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
} from '@kangentic/protocol';

// Persist the stub's static X25519 identity OUTSIDE the repo so restarting
// the stub (e.g. to pick up code changes, or after a phone reload) keeps the
// same desktop key the phone pinned at pairing - no re-pairing needed. The
// pairing token is still fresh per run (single-use); only the static key is
// stable. Delete this file to force a fresh identity.
const IDENTITY_FILE = join(tmpdir(), 'kangentic-stub-desktop-identity.json');

function generateAndPersistDesktopStatic() {
  const keypair = generateX25519KeyPair();
  writeFileSync(IDENTITY_FILE, JSON.stringify({ secretKey: bytesToHex(keypair.secretKey), publicKey: bytesToHex(keypair.publicKey) }));
  console.log(`[identity] generated a new stub desktop identity at ${IDENTITY_FILE}`);
  return keypair;
}

function loadOrCreateDesktopStatic() {
  if (existsSync(IDENTITY_FILE)) {
    try {
      const stored = JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
      return { secretKey: hexToBytes(stored.secretKey), publicKey: hexToBytes(stored.publicKey) };
    } catch (parseError) {
      console.log(`[identity] ignoring unreadable ${IDENTITY_FILE}: ${parseError.message}`);
    }
  }
  return generateAndPersistDesktopStatic();
}

function parseArgs(argv) {
  const relayIndex = argv.indexOf('--relay');
  const relayUrl = relayIndex >= 0 ? argv[relayIndex + 1] : 'ws://127.0.0.1:8080';
  // --yes: skip the interactive SAS confirmation (Maestro flows and
  // agent-driven runs have no stdin). The SAS still prints for an eyeball
  // check against the phone; this stub trusts its own loopback rig.
  const autoConfirm = argv.includes('--yes');
  // --phone-key <hex>: skip pairing and open the ongoing session directly,
  // for a phone already paired to this stub's persisted identity (printed as
  // "Phone static key: ..." on the first pairing). Lets the stub restart
  // without a re-pair.
  const phoneKeyIndex = argv.indexOf('--phone-key');
  const phoneKeyHex = phoneKeyIndex >= 0 ? argv[phoneKeyIndex + 1] : null;
  return { relayUrl, autoConfirm, phoneKeyHex };
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

/**
 * Canned Phase 2 data: one project, a small board, and one "live" session
 * that streams terminal chunks, flips activity states, and raises a
 * permission prompt after a while, so every phone surface (triage, board,
 * conversation, terminal, changes, prompt cards) has something real to
 * render without a desktop.
 */
const STUB_PROJECT = { id: 'stub-project', name: 'Stub Project' };
const STUB_SESSION_ID = 'stub-session-1';
const STUB_TASK_ID = 'stub-task-1';
const STUB_PROMPT_ID = `${STUB_SESSION_ID}:stub-tool-2`;

function nowIso() {
  return new Date().toISOString();
}

function stubColumns() {
  return [
    { id: 'lane-todo', name: 'To Do', description: null, role: 'todo', position: 0, color: '#3fb950', icon: null, is_archived: false, is_ghost: false },
    { id: 'lane-doing', name: 'Doing', description: null, role: null, position: 1, color: '#d29922', icon: null, is_archived: false, is_ghost: false },
    { id: 'lane-done', name: 'Done', description: null, role: 'done', position: 2, color: '#8957e5', icon: null, is_archived: false, is_ghost: false },
  ];
}

function stubTask(id, displayId, title, swimlaneId, position, sessionId) {
  return {
    id, display_id: displayId, title, description: 'Stubbed for manual integration testing.', swimlane_id: swimlaneId, position,
    agent: 'claude', session_id: sessionId, worktree_path: null, branch_name: sessionId ? 'feature/stub-work' : null,
    pr_number: null, pr_url: null, pr_state: null, base_branch: 'main', labels: [], priority: 0, attachment_count: 0,
    archived_at: null, created_at: nowIso(), updated_at: nowIso(),
  };
}

function stubBoardSnapshot() {
  return {
    projectId: STUB_PROJECT.id,
    columns: stubColumns(),
    tasks: [
      stubTask(STUB_TASK_ID, 1, 'Streaming stub session', 'lane-doing', 0, STUB_SESSION_ID),
      stubTask('stub-task-2', 2, 'A quiet backlog-ish card', 'lane-todo', 0, null),
    ],
    backlog: [],
  };
}

function stubTranscript(turnCount) {
  const entries = [
    { kind: 'user', uuid: 'stub-user-1', ts: Date.now() - 60000, text: 'Fix the login redirect bug and add a regression test.' },
    {
      kind: 'assistant', uuid: 'stub-assistant-1', ts: Date.now() - 55000,
      blocks: [
        { type: 'text', text: 'Looking at the auth flow now. The redirect drops the `next` parameter on **expired-session** logins.' },
        { type: 'tool_use', id: 'stub-tool-1', name: 'Bash', input: { command: 'rg -n "next=" src/auth' } },
      ],
    },
    { kind: 'tool_result', uuid: 'stub-result-1', ts: Date.now() - 50000, toolUseId: 'stub-tool-1', content: 'src/auth/login.ts:42: redirect(`/login?next=${encodeURIComponent(path)}`)' },
  ];
  if (turnCount > 1) {
    entries.push({
      kind: 'assistant', uuid: 'stub-assistant-2', ts: Date.now() - 5000,
      blocks: [{ type: 'tool_use', id: 'stub-tool-2', name: 'Bash', input: { command: 'npm run test:unit -- auth-redirect' } }],
    });
  }
  return entries;
}

function stubDiffFileList() {
  return {
    files: [
      { path: 'src/auth/login.ts', status: 'M', insertions: 8, deletions: 2, binary: false },
      { path: 'tests/auth-redirect.test.ts', status: 'A', insertions: 31, deletions: 0, binary: false },
    ],
    totalInsertions: 39,
    totalDeletions: 2,
  };
}

function stubDiffFileContent(filePath) {
  if (filePath === 'src/auth/login.ts') {
    return {
      original: 'export function loginRedirect(path) {\n  redirect("/login");\n}\n',
      modified: 'export function loginRedirect(path) {\n  const next = encodeURIComponent(path);\n  redirect(`/login?next=${next}`);\n}\n',
      language: 'typescript',
    };
  }
  return { original: '', modified: 'test("redirect keeps next", () => {\n  expect(loginRedirect("/boards")).toContain("next=");\n});\n', language: 'typescript' };
}

function runSession(relayUrl, desktopStatic, phoneStaticPublicKey) {
  const slotId = deriveSessionSlotId(desktopStatic.publicKey, phoneStaticPublicKey);
  return connect(`${relayUrl}?slot=${slotId}`).then((socket) => {
    let streams = null;
    let streamSubscribed = false;
    let transcriptTurnCount = 1;
    let permissionPending = false;
    let feedTimer = null;
    let feedTick = 0;

    function send(message) {
      if (!streams) throw new Error('session not established yet');
      const frame = streams.send.seal(encodeMessage(message));
      socket.send(wrapSessionFrame(SessionFrameKind.Application, frame).slice().buffer);
    }

    function sendEvent(event) {
      send({ type: 'event', event });
    }

    // A little agent-life simulator: terminal chunks stream continuously;
    // every ~12 ticks the transcript grows a turn; at tick 20 a permission
    // prompt raises and stays pending until the phone answers it.
    function startFeed() {
      if (feedTimer) return;
      feedTimer = setInterval(() => {
        if (!streams || !streamSubscribed) return;
        feedTick += 1;
        sendEvent({ kind: 'terminal', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: { data: `tick ${feedTick}: scanning src/auth for redirect handling...\r\n` } });
        if (feedTick % 12 === 0) {
          transcriptTurnCount += 1;
          sendEvent({ kind: 'transcript', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: stubTranscript(transcriptTurnCount) });
        }
        if (feedTick === 20 && !permissionPending) {
          permissionPending = true;
          sendEvent({ kind: 'activity', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: { type: 'permission', promptId: STUB_PROMPT_ID, pending: true } });
          sendEvent({ kind: 'activity', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: { type: 'activity', state: 'permission', reason: { kind: 'permission' } } });
          console.log('[feed] raised a permission prompt (answer it from the phone)');
        }
      }, 1000);
    }

    function answerCapabilityRequest(request) {
      const { requestId, verb, payload } = request;
      console.log(`[verb] ${verb}`, JSON.stringify(payload));
      const ok = (responsePayload) => send({ type: 'capability-response', requestId, ok: true, ...(responsePayload === undefined ? {} : { payload: responsePayload }) });
      const fail = (error) => send({ type: 'capability-response', requestId, ok: false, error });

      switch (verb) {
        case 'read-board':
          if (!payload.projectId) return ok({ projects: [STUB_PROJECT] });
          if (payload.action === 'unsubscribe') return ok();
          return ok(stubBoardSnapshot());
        case 'read-stream':
          if (payload.action === 'unsubscribe') { streamSubscribed = false; return ok(); }
          if (payload.sessionId !== STUB_SESSION_ID) return fail(`No such session: ${payload.sessionId}`);
          streamSubscribed = true;
          startFeed();
          setTimeout(() => {
            if (streamSubscribed) sendEvent({ kind: 'transcript', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: stubTranscript(transcriptTurnCount) });
          }, 100);
          return ok({
            scrollback: 'kangentic stub desktop\r\n$ claude\r\nWorking on the login redirect bug...\r\n',
            activity: { state: permissionPending ? 'permission' : 'thinking', reason: permissionPending ? { kind: 'permission' } : { kind: 'turn-active' } },
            usage: null,
            awaitedPromptId: permissionPending ? STUB_PROMPT_ID : null,
          });
        case 'read-diff':
          if (payload.action === 'unsubscribe') return ok();
          if (payload.filePath) return ok(stubDiffFileContent(payload.filePath));
          return ok(stubDiffFileList());
        case 'send-user-message':
          console.log(`[message] phone says: ${payload.text}`);
          return ok({ delivered: true });
        case 'move-task':
          return ok({ ok: true });
        case 'answer-permission-prompt':
          if (!permissionPending || payload.promptId !== STUB_PROMPT_ID) {
            return fail('promptId does not match the currently outstanding prompt (stale or already answered)');
          }
          permissionPending = false;
          console.log(`[prompt] answered with keystrokes ${JSON.stringify(payload.keystrokes)}`);
          setTimeout(() => {
            sendEvent({ kind: 'activity', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: { type: 'permission', promptId: STUB_PROMPT_ID, pending: false } });
            sendEvent({ kind: 'activity', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } } });
          }, 50);
          return ok({ answered: true });
        case 'interactive-terminal':
          console.log(`[pty] phone wrote ${JSON.stringify(payload.data)}`);
          sendEvent({ kind: 'terminal', sessionId: STUB_SESSION_ID, taskId: STUB_TASK_ID, payload: { data: payload.data.replace(/\r/g, '\r\n') } });
          return ok({ written: true });
        case 'board-tool-read':
          return ok({ result: { note: `stub answered ${payload.tool}` } });
        case 'board-tool-write':
          console.log(`[board-tool] ${payload.tool}`, JSON.stringify(payload.params));
          return ok({ result: { created: 'stub-created-task' } });
        default:
          return fail(`Stub has no handler for ${verb}`);
      }
    }

    // The current in-progress KK handshake (reassigned on each re-initiation),
    // read by the persistent frame handler below.
    let handshake = null;

    // The desktop always INITIATES the KK handshake. It does so on first
    // connect and then on its ~2-minute rekey timer; that timer is also what
    // recovers a phone that dropped and reconnected (the phone is the
    // responder and only reacts to an inbound handshake). We re-initiate on a
    // faster interval here so a dev reload of the app re-establishes quickly.
    function initiateHandshake() {
      handshake = createKKHandshake({ initiator: true, localStatic: desktopStatic, remoteStatic: phoneStaticPublicKey });
      const { message } = handshake.writeMessage(new Uint8Array(0));
      socket.send(wrapSessionFrame(SessionFrameKind.Handshake, message).slice().buffer);
    }

    onFrame(socket, (frame) => {
      const { kind, payload } = unwrapSessionFrame(frame);
      if (kind === SessionFrameKind.Handshake) {
        if (!handshake) return;
        let result;
        try {
          result = handshake.readMessage(payload);
        } catch {
          // A reply to a since-superseded re-handshake attempt (the ~10s
          // rekey races the phone's response); drop it and wait for the
          // reply to the current handshake.
          return;
        }
        if (!result.split) return;
        streams = deriveSecretstreamPair(handshake.getChainingKey(), true);
        console.log('[session] established');
        return;
      }
      if (!streams) return;
      let opened;
      try {
        opened = streams.receive.open(payload);
      } catch {
        // A frame sealed under a superseded rekey can arrive mid-transition; ignore it.
        return;
      }
      if (opened.tag === FrameTag.Final) {
        console.log('[session] remote closed');
        return;
      }
      const message = decodeMessage(opened.plaintext);
      if (message.type === 'capability-request') {
        answerCapabilityRequest(message);
      } else if (message.type !== 'heartbeat') {
        console.log('[session] received:', message);
      }
    });

    initiateHandshake();
    const rehandshakeTimer = setInterval(initiateHandshake, 10_000);
    socket.addEventListener('close', () => clearInterval(rehandshakeTimer));
    return { send, socket };
  });
}

// `adb shell input text` (the only way to get the pairing link onto an
// emulator without a camera) cannot type base64url's '_'. To keep manual
// emulator pairing frictionless, regenerate the token - and, if a persisted
// key makes it unavoidable, the key - until the QR blob contains no '_'.
// This costs a negligible fraction of a bit of token entropy and is a
// test-harness accommodation only; real pairing scans a QR.
function isEmulatorTypeable(uri) {
  return uri.indexOf('_') === -1;
}

async function main() {
  const { relayUrl, autoConfirm, phoneKeyHex } = parseArgs(process.argv.slice(2));

  // Already-paired fast path: open the ongoing session directly, no pairing.
  if (phoneKeyHex) {
    const desktopStatic = loadOrCreateDesktopStatic();
    const phoneStaticPublicKey = hexToBytes(phoneKeyHex);
    console.log(`Relay: ${relayUrl}`);
    console.log(`Session-only mode: reconnecting to the phone paired at ${bytesToHex(phoneStaticPublicKey)}`);
    const session = await runSession(relayUrl, desktopStatic, phoneStaticPublicKey);
    setInterval(() => {
      try {
        session.send({ type: 'heartbeat' });
      } catch {
        // Not established between re-handshakes; skip this heartbeat.
      }
    }, 5_000);
    return;
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  let desktopStatic = loadOrCreateDesktopStatic();
  let pairingToken;
  let qrUri;
  let tokenAttempts = 0;
  for (;;) {
    pairingToken = randomBytes(32);
    qrUri = encodePairingQrPayload({
      desktopStaticPublicKey: desktopStatic.publicKey,
      pairingToken,
      relayAddress: relayUrl,
      expiresAt,
      protocolVersion: PROTOCOL_VERSION,
    });
    if (isEmulatorTypeable(qrUri)) break;
    tokenAttempts += 1;
    if (tokenAttempts >= 300) {
      // The loaded key forces a '_' no token can avoid; regenerate + re-persist it.
      desktopStatic = generateAndPersistDesktopStatic();
      tokenAttempts = 0;
    }
  }

  console.log(`Relay: ${relayUrl}`);
  console.log(`Pairing URI (paste into the app's "paste pairing link" field):\n${qrUri}\n`);
  console.log('Waiting for the phone to connect...');

  const { phoneStaticPublicKey, sas } = await runPairing(relayUrl, desktopStatic, pairingToken);
  console.log(`\nSAS - confirm this matches the phone's screen:`);
  console.log(`  digits: ${sas.digits}`);
  console.log(`  emoji:  ${sas.emoji.join(' ')}`);

  if (autoConfirm) {
    console.log('\n--yes given: auto-confirming the SAS (eyeball it against the phone anyway).');
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nDoes the SAS match? [y/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('Not confirmed - exiting.');
      process.exit(1);
    }
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
