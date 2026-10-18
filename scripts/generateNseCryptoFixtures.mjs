/**
 * Regenerates tests/swift/pushEnvelopeFixtures.json.
 *
 * The iOS Notification Service Extension re-implements XChaCha20-Poly1305 in
 * Swift, because CryptoKit ships only the 96-bit-nonce IETF variant. Nothing on
 * a Windows machine can run that Swift, and this project has no iOS test tier,
 * so the only way to know the two implementations agree is to seal envelopes
 * here with the protocol package's own `sealPushEnvelope` and have a `swiftc`
 * job open them.
 *
 * Committed rather than generated at test time so the Swift harness needs no
 * Node, and so a change to the fixtures is visible in review.
 *
 * Since protocol 0.23.0 it also carries the extension's notification pruning
 * (targets/nse/NotificationPruning.swift): envelopes with piggybacked `clears`
 * whose expected parse is the protocol's own `parsePushClearEntries`, a truth
 * table of which delivered alerts a push removes (`matchCases`, which
 * tests/unit/nseCrypto.test.ts also runs through the app's TypeScript matcher,
 * so one table binds both platforms), and `threadIdentifierVectors` computed
 * here with @noble/hashes and checked against CryptoKit.
 *
 * Run: node scripts/generateNseCryptoFixtures.mjs
 */
import { Buffer } from 'node:buffer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sealPushEnvelope, openPushEnvelope, parsePushClearEntries, randomBytes, bytesToHex } from '@kangentic/protocol';
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
/**
 * Deliberately NOT under targets/nse/. That directory is shippable extension
 * source, copied wholesale into the generated Xcode target by
 * plugins/withIosNotificationServiceExtension.ts, and a fixture or a test
 * harness landing inside the extension bundle would be both wasteful and a
 * privacy smell.
 */
const outputPath = join(scriptDir, '..', 'tests', 'swift', 'pushEnvelopeFixtures.json');

const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64UrlEncode(bytes) {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : null;
    const third = index + 2 < bytes.length ? bytes[index + 2] : null;
    encoded += BASE64_URL_ALPHABET[first >> 2];
    encoded += BASE64_URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== null) encoded += BASE64_URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third !== null) encoded += BASE64_URL_ALPHABET[third & 0x3f];
  }
  return encoded;
}

function base64UrlDecode(encoded) {
  const standard = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(standard, 'base64'));
}

/**
 * HChaCha20, implemented here so the expected subkey in the fixture is a value
 * this script derived rather than a constant copied out of a specification from
 * memory. selfCheckHChaCha20 below proves it correct before it is used.
 */
export function hchacha20(key, nonceHead) {
  const state = new Uint32Array(16);
  state[0] = 0x61707865;
  state[1] = 0x3320646e;
  state[2] = 0x79622d32;
  state[3] = 0x6b206574;
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let index = 0; index < 8; index += 1) state[4 + index] = view.getUint32(index * 4, true);
  const nonceView = new DataView(nonceHead.buffer, nonceHead.byteOffset, nonceHead.byteLength);
  for (let index = 0; index < 4; index += 1) state[12 + index] = nonceView.getUint32(index * 4, true);

  const rotateLeft = (value, count) => ((value << count) | (value >>> (32 - count))) >>> 0;
  const quarterRound = (a, b, c, d) => {
    state[a] = (state[a] + state[b]) >>> 0;
    state[d] = rotateLeft(state[d] ^ state[a], 16);
    state[c] = (state[c] + state[d]) >>> 0;
    state[b] = rotateLeft(state[b] ^ state[c], 12);
    state[a] = (state[a] + state[b]) >>> 0;
    state[d] = rotateLeft(state[d] ^ state[a], 8);
    state[c] = (state[c] + state[d]) >>> 0;
    state[b] = rotateLeft(state[b] ^ state[c], 7);
  };

  for (let round = 0; round < 10; round += 1) {
    quarterRound(0, 4, 8, 12);
    quarterRound(1, 5, 9, 13);
    quarterRound(2, 6, 10, 14);
    quarterRound(3, 7, 11, 15);
    quarterRound(0, 5, 10, 15);
    quarterRound(1, 6, 11, 12);
    quarterRound(2, 7, 8, 13);
    quarterRound(3, 4, 9, 14);
  }

  const subkey = new Uint8Array(32);
  const subkeyView = new DataView(subkey.buffer);
  const words = [0, 1, 2, 3, 12, 13, 14, 15];
  words.forEach((word, position) => subkeyView.setUint32(position * 4, state[word], true));
  return subkey;
}

/**
 * Proves the implementation above by the identity XChaCha20-Poly1305 is defined
 * by: sealing with xchacha20poly1305 must equal sealing with the IETF cipher
 * under the derived subkey and the 0^4 || nonce[16..24] nonce. If this holds,
 * the subkey emitted into the fixture is trustworthy.
 */
export function selfCheckHChaCha20() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const key = randomBytes(32);
    const nonce = randomBytes(24);
    const message = randomBytes(1 + attempt * 3);
    const additionalData = randomBytes(32);

    const viaXChaCha = xchacha20poly1305(key, nonce, additionalData).encrypt(message);

    const subkey = hchacha20(key, nonce.subarray(0, 16));
    const ietfNonce = new Uint8Array(12);
    ietfNonce.set(nonce.subarray(16, 24), 4);
    const viaIetf = chacha20poly1305(subkey, ietfNonce, additionalData).encrypt(message);

    if (bytesToHex(viaXChaCha) !== bytesToHex(viaIetf)) {
      throw new Error('HChaCha20 self-check failed: the derived subkey does not reproduce XChaCha20-Poly1305.');
    }
  }
}

function tamper(blob) {
  const bytes = base64UrlDecode(blob);
  // Flip a bit in the Poly1305 tag, the last 16 bytes.
  bytes[bytes.length - 1] ^= 0x01;
  return base64UrlEncode(bytes);
}

/** HKDF info label for the extension's thread key; NotificationPruning.threadKeyInfo must match. */
export const THREAD_KEY_INFO = 'kangentic nse thread v1';

/**
 * The extension's opaque threadIdentifier (NotificationPruning.threadIdentifier),
 * written independently with @noble/hashes so the Swift CryptoKit version is
 * checked against a second implementation rather than against itself:
 * HKDF-SHA256(push key, no salt, THREAD_KEY_INFO) -> 32-byte thread key, then
 * HMAC-SHA256(thread key, "task:<taskId>" else "project:<projectId>"), first
 * 16 bytes, lowercase hex. Null when the alert names neither.
 */
export function threadIdentifier(pushKeyBytes, taskId, projectId) {
  const subject = taskId.length > 0 ? `task:${taskId}` : projectId.length > 0 ? `project:${projectId}` : null;
  if (subject === null) return null;
  const encoder = new TextEncoder();
  const threadKey = hkdf(sha256, pushKeyBytes, undefined, encoder.encode(THREAD_KEY_INFO), 32);
  return bytesToHex(hmac(sha256, threadKey, encoder.encode(subject)).subarray(0, 16));
}

selfCheckHChaCha20();

const pushKey = randomBytes(32);
const identityPublicKey = randomBytes(32);
const otherPushKey = randomBytes(32);
const otherIdentityPublicKey = randomBytes(32);

// Stamped at generation time, then BAKED INTO THE FIXTURE and injected by the
// Swift harness as its "now" instead of the clock. That is what keeps the
// freshness cases meaningful however long after generation the harness runs:
// a fixed literal here would be rejected as stale by the round-trip check
// below the moment it aged past the 24h window.
const nowMilliseconds = Date.now();
const HOUR_MS = 60 * 60 * 1000;

const basePlaintext = {
  category: 'input-required',
  projectId: 'project-alpha',
  taskId: 'task-42',
  sessionId: 'session-7',
  taskTitle: 'Wire the relay reconnect',
  detail: 'Needs your approval to run the migration',
  sentAt: nowMilliseconds - 30_000,
};

/**
 * Piggybacked clears (protocol 0.23.0), two valid entries around every shape
 * the protocol's tolerant parser drops on its own: an unknown category, a
 * non-string id, a non-numeric and a boolean `notifiedAt`, a non-object. The
 * EXPECTED list is the protocol's own parse of this array, never a hand-copied
 * one, so the Swift parser is held to what the package actually keeps.
 */
const rawPiggybackedClears = [
  { category: 'input-required', projectId: 'project-alpha', taskId: 'task-42', sessionId: 'session-6', notifiedAt: nowMilliseconds - 60_000 },
  { category: 'not-a-category', projectId: 'project-alpha', taskId: 'task-42', sessionId: 'session-6', notifiedAt: nowMilliseconds - 60_000 },
  { category: 'input-required', projectId: 7, taskId: 'task-42', sessionId: 'session-6', notifiedAt: nowMilliseconds - 60_000 },
  { category: 'input-required', projectId: 'project-alpha', taskId: 'task-42', sessionId: 'session-6', notifiedAt: 'soon' },
  { category: 'input-required', projectId: 'project-alpha', taskId: 'task-42', sessionId: 'session-6', notifiedAt: true },
  'not-an-object',
  null,
  {
    category: 'spawn-stalled',
    projectId: 'project-alpha',
    taskId: 'task-42',
    sessionId: '',
    notifiedAt: nowMilliseconds - 90_000,
    sessionKind: 'not-a-kind',
  },
];

const cases = [
  {
    name: 'good',
    blob: sealPushEnvelope(pushKey, identityPublicKey, basePlaintext),
    expected: basePlaintext,
  },
  {
    name: 'empty-detail-falls-back-to-the-bare-task-title',
    blob: sealPushEnvelope(pushKey, identityPublicKey, { ...basePlaintext, detail: '' }),
    expected: { ...basePlaintext, detail: '' },
  },
  {
    name: 'empty-task-title-uses-the-agent-session-fallback',
    blob: sealPushEnvelope(pushKey, identityPublicKey, { ...basePlaintext, taskTitle: '', detail: '' }),
    expected: { ...basePlaintext, taskTitle: '', detail: '' },
  },
  {
    name: 'every-category-opens',
    blob: sealPushEnvelope(pushKey, identityPublicKey, { ...basePlaintext, category: 'spawn-stalled' }),
    expected: { ...basePlaintext, category: 'spawn-stalled' },
  },
  {
    // A workflow-complete (protocol 0.21.0) names no task or session: the
    // desktop sends EMPTY task and session ids, the workflow's name as the
    // title and its HOME project. The extension must still open it and give
    // it a title, never treat the empty ids as a malformed envelope.
    name: 'workflow-complete-empty-ids',
    blob: sealPushEnvelope(pushKey, identityPublicKey, {
      ...basePlaintext,
      category: 'workflow-complete',
      taskId: '',
      sessionId: '',
      taskTitle: 'Checkout hardening',
      detail: 'All 6 tasks are in Done.',
    }),
    expected: {
      ...basePlaintext,
      category: 'workflow-complete',
      taskId: '',
      sessionId: '',
      taskTitle: 'Checkout hardening',
      detail: 'All 6 tasks are in Done.',
    },
  },
  {
    name: 'piggybacked-clears-parse-tolerantly',
    blob: sealPushEnvelope(pushKey, identityPublicKey, { ...basePlaintext, clears: rawPiggybackedClears }),
    expected: { ...basePlaintext, clears: parsePushClearEntries(rawPiggybackedClears) },
  },
  {
    // A malformed list must never cost the notification it rides on.
    name: 'malformed-clears-list-still-opens',
    blob: sealPushEnvelope(pushKey, identityPublicKey, { ...basePlaintext, clears: 'not-a-list' }),
    expected: { ...basePlaintext, clears: [] },
  },
  {
    name: 'tampered-tag',
    blob: tamper(sealPushEnvelope(pushKey, identityPublicKey, basePlaintext)),
    expected: null,
  },
  {
    name: 'sealed-with-a-different-push-key',
    blob: sealPushEnvelope(otherPushKey, identityPublicKey, basePlaintext),
    expected: null,
  },
  {
    name: 'sealed-for-a-different-recipient-aad-mismatch',
    blob: sealPushEnvelope(pushKey, otherIdentityPublicKey, basePlaintext),
    expected: null,
  },
  {
    name: 'stale-sent-at',
    blob: sealPushEnvelope(pushKey, identityPublicKey, { ...basePlaintext, sentAt: nowMilliseconds - 25 * HOUR_MS }),
    expected: null,
  },
  {
    name: 'sent-at-too-far-in-the-future',
    blob: sealPushEnvelope(pushKey, identityPublicKey, { ...basePlaintext, sentAt: nowMilliseconds + 10 * 60 * 1000 }),
    expected: null,
  },
  { name: 'too-short-to-hold-a-nonce-and-tag', blob: base64UrlEncode(new Uint8Array(20)), expected: null },
  { name: 'not-a-blob-at-all', blob: 'not-a-blob', expected: null },
];

// Every positive case must genuinely open with the protocol's own reader, so a
// bad fixture cannot make the Swift harness vacuously green.
for (const testCase of cases) {
  if (testCase.expected === null) continue;
  const opened = openPushEnvelope(pushKey, identityPublicKey, testCase.blob);
  if (opened.taskId !== testCase.expected.taskId) {
    throw new Error(`Fixture "${testCase.name}" does not round-trip through openPushEnvelope.`);
  }
  if (JSON.stringify(opened.clears ?? []) !== JSON.stringify(testCase.expected.clears ?? [])) {
    throw new Error(`Fixture "${testCase.name}" clears do not round-trip through openPushEnvelope.`);
  }
}

/**
 * Which delivered alerts an incoming push removes, as a truth table both
 * platforms are held to: the Swift harness runs it through
 * NotificationPruning, and tests/unit/nseCrypto.test.ts runs the `covers` rows
 * through the app's clearEntryCovers and the `supersedes` rows' identities
 * through notificationIdForRouting, the Android stable id.
 *
 * - `covers`: does a clear entry remove the delivered alert? Same category and
 *   all three ids, and the alert's `sentAt` at or before `notifiedAt`.
 * - `supersedes`: does the incoming push replace the delivered alert? Same
 *   stable identity (category + session, else task, else project), and the
 *   delivered one sealed at or before the incoming one.
 */
const deliveredAlert = {
  category: 'input-required',
  projectId: 'project-alpha',
  taskId: 'task-42',
  sessionId: 'session-7',
  sentAt: nowMilliseconds - 60_000,
};
const alertIds = { category: 'input-required', projectId: 'project-alpha', taskId: 'task-42', sessionId: 'session-7' };
const workflowAlert = { category: 'workflow-complete', projectId: 'project-alpha', taskId: '', sessionId: '', sentAt: nowMilliseconds - 60_000 };
const stalledAlert = { category: 'spawn-stalled', projectId: 'project-alpha', taskId: 'task-42', sessionId: '', sentAt: nowMilliseconds - 60_000 };

const matchCases = [
  { name: 'clear-covers-an-alert-sent-before-notified-at', kind: 'covers', entry: { ...alertIds, notifiedAt: deliveredAlert.sentAt + 1_000 }, delivered: deliveredAlert, expected: true },
  { name: 'clear-covers-an-alert-sent-exactly-at-notified-at', kind: 'covers', entry: { ...alertIds, notifiedAt: deliveredAlert.sentAt }, delivered: deliveredAlert, expected: true },
  { name: 'clear-keeps-an-alert-sent-after-notified-at', kind: 'covers', entry: { ...alertIds, notifiedAt: deliveredAlert.sentAt - 1 }, delivered: deliveredAlert, expected: false },
  { name: 'clear-keeps-another-category', kind: 'covers', entry: { ...alertIds, category: 'turn-complete', notifiedAt: nowMilliseconds }, delivered: deliveredAlert, expected: false },
  { name: 'clear-keeps-another-session', kind: 'covers', entry: { ...alertIds, sessionId: 'session-8', notifiedAt: nowMilliseconds }, delivered: deliveredAlert, expected: false },
  { name: 'clear-keeps-another-task', kind: 'covers', entry: { ...alertIds, taskId: 'task-43', notifiedAt: nowMilliseconds }, delivered: deliveredAlert, expected: false },
  { name: 'clear-keeps-another-project', kind: 'covers', entry: { ...alertIds, projectId: 'project-beta', notifiedAt: nowMilliseconds }, delivered: deliveredAlert, expected: false },
  {
    name: 'clear-covers-spawn-stalled-with-an-empty-session',
    kind: 'covers',
    entry: { category: 'spawn-stalled', projectId: 'project-alpha', taskId: 'task-42', sessionId: '', notifiedAt: nowMilliseconds },
    delivered: stalledAlert,
    expected: true,
  },
  {
    name: 'newer-push-supersedes-the-same-session-and-category',
    kind: 'supersedes',
    incoming: { ...deliveredAlert, sentAt: deliveredAlert.sentAt + 5_000 },
    delivered: deliveredAlert,
    incomingIdentityKey: 'kangentic:input-required:session:session-7',
    expected: true,
  },
  {
    name: 'older-push-arriving-late-supersedes-nothing',
    kind: 'supersedes',
    incoming: { ...deliveredAlert, sentAt: deliveredAlert.sentAt - 5_000 },
    delivered: deliveredAlert,
    incomingIdentityKey: 'kangentic:input-required:session:session-7',
    expected: false,
  },
  {
    name: 'another-session-of-the-same-task-is-kept',
    kind: 'supersedes',
    incoming: { ...deliveredAlert, sessionId: 'session-8', sentAt: nowMilliseconds },
    delivered: deliveredAlert,
    incomingIdentityKey: 'kangentic:input-required:session:session-8',
    expected: false,
  },
  {
    name: 'another-category-of-the-same-session-is-kept',
    kind: 'supersedes',
    incoming: { ...deliveredAlert, category: 'turn-complete', sentAt: nowMilliseconds },
    delivered: deliveredAlert,
    incomingIdentityKey: 'kangentic:turn-complete:session:session-7',
    expected: false,
  },
  {
    name: 'workflow-complete-supersedes-within-its-project',
    kind: 'supersedes',
    incoming: { ...workflowAlert, sentAt: nowMilliseconds },
    delivered: workflowAlert,
    incomingIdentityKey: 'kangentic:workflow-complete:project:project-alpha',
    expected: true,
  },
  {
    name: 'workflow-complete-of-another-project-is-kept',
    kind: 'supersedes',
    incoming: { ...workflowAlert, projectId: 'project-beta', sentAt: nowMilliseconds },
    delivered: workflowAlert,
    incomingIdentityKey: 'kangentic:workflow-complete:project:project-beta',
    expected: false,
  },
  {
    name: 'spawn-stalled-supersedes-by-task',
    kind: 'supersedes',
    incoming: { ...stalledAlert, sentAt: nowMilliseconds },
    delivered: stalledAlert,
    incomingIdentityKey: 'kangentic:spawn-stalled:task:task-42',
    expected: true,
  },
];

const threadIdentifierVectors = [
  { name: 'keys-on-the-task', taskId: 'task-42', projectId: 'project-alpha' },
  { name: 'a-task-without-a-project-still-keys-on-the-task', taskId: 'task-42', projectId: '' },
  { name: 'workflow-complete-falls-back-to-its-project', taskId: '', projectId: 'project-alpha' },
  { name: 'non-ascii-ids-hash-as-utf8', taskId: 'tâche-✓', projectId: 'project-alpha' },
  { name: 'an-alert-naming-nothing-has-no-thread', taskId: '', projectId: '' },
].map((vector) => ({ ...vector, expected: threadIdentifier(pushKey, vector.taskId, vector.projectId) }));

// The RFC's own HChaCha20 input, so a failure isolates subkey derivation from
// the nonce split and the AEAD.
const vectorKey = Uint8Array.from({ length: 32 }, (_unused, index) => index);
const vectorNonce = Uint8Array.from([
  0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x4a, 0x00, 0x00, 0x00, 0x00, 0x31, 0x41, 0x59, 0x27,
]);

const fixtures = {
  generatedBy: 'scripts/generateNseCryptoFixtures.mjs',
  pushKeyHex: bytesToHex(pushKey),
  identityPublicKeyHex: bytesToHex(identityPublicKey),
  nowMilliseconds,
  hchacha20Vector: {
    keyHex: bytesToHex(vectorKey),
    nonceHeadHex: bytesToHex(vectorNonce),
    subkeyHex: bytesToHex(hchacha20(vectorKey, vectorNonce)),
  },
  cases,
  matchCases,
  threadIdentifierVectors,
};

/**
 * Only writes when run as a script. tests/unit/nseCrypto.test.ts imports this
 * module for `hchacha20` and `selfCheckHChaCha20`, and an import must not
 * rewrite a committed fixture underneath the assertions checking it.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${cases.length} cases to ${outputPath}`);
}
