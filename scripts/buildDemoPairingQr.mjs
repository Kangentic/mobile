#!/usr/bin/env node
/**
 * Builds (and verifies) the reviewer/demo pairing QR.
 *
 * The demo code is a permanent, non-expiring pairing URI that App Store Review
 * scans to reach a self-contained demo of the app with no desktop and no
 * network. See src/demo/demoIdentity.ts for why it exists and why none of the
 * key material here is a secret.
 *
 * DEFAULT MODE IS VERIFY, NOT REGENERATE. The URI is a frozen literal in
 * src/demo/demoIdentity.ts, and a QR built from it may already be in Apple's
 * hands with no way to reissue it mid-review. So this script derives the
 * identity independently, re-encodes the payload, and REFUSES to write anything
 * if the result disagrees with the committed literal. That disagreement is the
 * whole failure mode worth catching: it means someone changed a derivation
 * label, and the app would no longer recognise the QR already published.
 *
 * A protocol-version bump is the one difference that is expected and harmless -
 * the version rides inside the blob but is never read back (the demo is matched
 * as an exact string, never decoded), so the frozen literal stays valid across
 * bumps. `--rotate` is the deliberate escape hatch for genuinely minting a new
 * code, and it prints the literal to paste rather than editing source itself.
 *
 * Usage:
 *   node scripts/buildDemoPairingQr.mjs            # verify + write the images
 *   node scripts/buildDemoPairingQr.mjs --rotate   # print a freshly encoded URI
 *
 * Not run in CI: this is a dev utility like captureClaudeFrames.mjs, and its
 * output is committed. tests/unit/demoPairing.test.ts is the CI-side guard that
 * the committed literal still carries the committed key material.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';
import { PROTOCOL_VERSION, encodePairingQrPayload, x25519PublicKeyFrom } from '@kangentic/protocol';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, '..');
const identitySourcePath = join(repositoryRoot, 'src', 'demo', 'demoIdentity.ts');
const outputDirectory = join(repositoryRoot, 'store', 'review');

const KEY_MATERIAL_LENGTH = 32;

/**
 * Deliberately a SECOND implementation of demoIdentity.ts's derivation rather
 * than an import of it. Importing would make the two agree by construction and
 * verify nothing; re-deriving is what turns the comparison below into a real
 * check on the committed literal.
 */
function labelBytes(label) {
  const bytes = new Uint8Array(KEY_MATERIAL_LENGTH);
  bytes.set(new TextEncoder().encode(label).slice(0, KEY_MATERIAL_LENGTH));
  return bytes;
}

function buildPairingUri() {
  return encodePairingQrPayload({
    desktopStaticPublicKey: x25519PublicKeyFrom(labelBytes('kangentic-demo-desktop-static-v1')),
    pairingToken: labelBytes('kangentic-demo-pairing-token-v1'),
    relayAddress: 'wss://demo.kangentic.com',
    expiresAt: '2099-12-31T23:59:59.000Z',
    protocolVersion: PROTOCOL_VERSION,
  });
}

/** The frozen literal, read out of source rather than imported (this is a .mjs script; that file is TypeScript). */
function committedPairingUri() {
  const source = readFileSync(identitySourcePath, 'utf8');
  const match = /export const DEMO_PAIRING_URI =\s*'([^']+)'/.exec(source);
  if (match === null) {
    console.error('buildDemoPairingQr: could not find DEMO_PAIRING_URI in src/demo/demoIdentity.ts.');
    process.exit(1);
  }
  return match[1];
}

const rotating = process.argv.includes('--rotate');
const rebuilt = buildPairingUri();

if (rotating) {
  console.log('Paste this into src/demo/demoIdentity.ts as DEMO_PAIRING_URI, then re-run without --rotate:\n');
  console.log(`'${rebuilt}'`);
  process.exit(0);
}

const committed = committedPairingUri();
if (committed !== rebuilt) {
  console.error(
    'buildDemoPairingQr: the committed DEMO_PAIRING_URI does not match what this script derives.\n' +
      '  Committed: ' + committed + '\n' +
      '  Derived:   ' + rebuilt + '\n' +
      '  A derivation label in src/demo/demoIdentity.ts has changed. Any QR already published\n' +
      '  (including one sitting in App Store Review) encodes the COMMITTED string, so changing\n' +
      '  it silently breaks the demo for reviewers who already have the old image.\n' +
      '  Restore the labels, or mint a new code deliberately with --rotate and reissue the QR.',
  );
  process.exit(1);
}

mkdirSync(outputDirectory, { recursive: true });

// Black on white with a wide quiet zone: a reviewer may be scanning this off a
// laptop screen at an angle, and error correction level H tolerates that plus a
// reflection or two. The payload is only ~185 characters, so the density cost of
// H is irrelevant here.
const renderOptions = { errorCorrectionLevel: 'H', margin: 4, color: { dark: '#000000ff', light: '#ffffffff' } };

const pngPath = join(outputDirectory, 'demo-pairing-qr.png');
const svgPath = join(outputDirectory, 'demo-pairing-qr.svg');

await QRCode.toFile(pngPath, committed, { ...renderOptions, type: 'png', width: 1024 });
writeFileSync(svgPath, await QRCode.toString(committed, { ...renderOptions, type: 'svg' }), 'utf8');

console.log(`buildDemoPairingQr: verified the committed URI and wrote\n  ${pngPath}\n  ${svgPath}`);
console.log('\nScan target:');
console.log(await QRCode.toString(committed, { type: 'terminal', small: true }));
