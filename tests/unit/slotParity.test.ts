/**
 * Both relay slots must byte-match what the desktop dials (startPairing ->
 * derivePairingSlotId, openSessionForDevice -> deriveSessionSlotId), or the two
 * sides never rendezvous. Phase 1 shipped a hex-of-the-desktop-key candidate
 * that did NOT match; this locks both mobile derivations to the protocol
 * package's canonical exports so neither can drift locally again.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bytesToHex, derivePairingSlotId, deriveSessionSlotId, generateX25519KeyPair, randomBytes } from '@kangentic/protocol';
import { deriveSlotId } from '@/channel/slot';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptsDir = join(repoRoot, 'scripts');
const ciScriptsDir = join(repoRoot, '.github', 'scripts');

describe('deriveSlotId', () => {
  it('pairing slot byte-matches the protocol package derivation the desktop dials', () => {
    const pairingToken = new Uint8Array(32).fill(7);
    const slotId = deriveSlotId({ kind: 'pairing', pairingToken });

    expect(slotId).toBe(derivePairingSlotId(pairingToken));
    // The labeled derivation is 16 bytes -> 32 hex chars, and is NOT the raw
    // token: the token is the Noise PSK, and the slot travels in cleartext in
    // the relay URL, so dialing the token verbatim would publish the PSK.
    expect(slotId).toHaveLength(32);
    expect(slotId).not.toBe(bytesToHex(pairingToken));
  });

  it('session slot byte-matches the protocol package derivation the desktop dials', () => {
    const desktopIdentity = generateX25519KeyPair();
    const phoneIdentity = generateX25519KeyPair();

    const slotId = deriveSlotId({
      kind: 'session',
      desktopStaticPublicKey: desktopIdentity.publicKey,
      phoneStaticPublicKey: phoneIdentity.publicKey,
    });

    expect(slotId).toBe(deriveSessionSlotId(desktopIdentity.publicKey, phoneIdentity.publicKey));
    // The labeled derivation is 16 bytes -> 32 hex chars, and is NOT the raw desktop key.
    expect(slotId).toHaveLength(32);
    expect(slotId).not.toBe(bytesToHex(desktopIdentity.publicKey));
  });

  it('session slot is asymmetric in key order (desktop-first is the contract)', () => {
    const desktopIdentity = generateX25519KeyPair();
    const phoneIdentity = generateX25519KeyPair();
    const forward = deriveSessionSlotId(desktopIdentity.publicKey, phoneIdentity.publicKey);
    const reversed = deriveSessionSlotId(phoneIdentity.publicKey, desktopIdentity.publicKey);
    expect(forward).not.toBe(reversed);
  });
});

/**
 * scripts/stubDesktopPeer.mjs is the desktop stand-in `dev:stub` and the
 * paired Maestro suite pair against. It cannot be imported directly - it
 * runs `main()` (real WebSocket connections) as a top-level side effect at
 * import time, and there is no `import.meta.url` guard to make it inert,
 * nor should one be added just to satisfy a test. A source scan is the
 * mechanism the repo already uses for a rig script that cannot be safely
 * imported (see the dev.mjs kill-target scan below in
 * rigProcessRegistry.test.ts): it locks the script to calling the SAME
 * canonical protocol export `src/channel/slot.ts` calls, so a future edit
 * that reintroduces `bytesToHex(pairingToken)` (the pre-0.12.0 behavior,
 * which also published the Noise PSK in the relay URL) fails here instead
 * of failing silently as a `dev:stub` rendezvous that hangs until the
 * relay's park timeout.
 */
describe('scripts/stubDesktopPeer.mjs pairing slot matches src/channel/slot.ts', () => {
  const stubSource = readFileSync(join(scriptsDir, 'stubDesktopPeer.mjs'), 'utf8');

  it('is scanning a file that still contains the pairing rendezvous (non-vacuity guard)', () => {
    expect(stubSource).toContain('runPairing');
    expect(stubSource).toContain('derivePairingSlotId');
  });

  it('imports derivePairingSlotId from @kangentic/protocol (the canonical export, not a local reimplementation)', () => {
    const importBlock = stubSource.match(/import \{([^}]+)\} from '@kangentic\/protocol';/);
    expect(importBlock).not.toBeNull();
    const specifiers = importBlock![1].split(',').map((specifier) => specifier.trim());
    expect(specifiers).toContain('derivePairingSlotId');
  });

  it('computes the pairing slot with derivePairingSlotId(pairingToken), never bytesToHex(pairingToken)', () => {
    expect(stubSource).toMatch(/const slotId = derivePairingSlotId\(pairingToken\);/);
    // The pre-0.12.0 shape: dialing the token verbatim as the slot, which
    // published the Noise PSK in the relay URL's query string.
    expect(stubSource).not.toMatch(/const slotId = bytesToHex\(pairingToken\)/);
  });
});

/**
 * `.github/scripts/run-maestro-paired.sh` and `scripts/dev.mjs` both hand-
 * maintain a comment demanding their SLOT_ID_PATTERN / RELAY_SLOT_PATTERN
 * stay "identical", with no shared source of truth. Both halves are needed and
 * neither is sufficient: a literal comparison of the two copies proves only
 * that they agree with EACH OTHER, which stays true if both drift away from
 * what the app dials, while checking one copy against the real derivations
 * leaves the other free to rot silently until a CI-only rendezvous failure.
 * So this asserts both - the two copies match, AND each independently accepts
 * every relay slot this app actually produces. Otherwise `dev:stub` (or the
 * `maestro-paired` job) never rendezvous even though every individual piece
 * looks correct in isolation.
 */
describe('the rig relay slot patterns accept both derived relay slots', () => {
  const devRigSource = readFileSync(join(scriptsDir, 'dev.mjs'), 'utf8');
  const ciRigSource = readFileSync(join(ciScriptsDir, 'run-maestro-paired.sh'), 'utf8');
  const devRigPatternMatch = devRigSource.match(/const RELAY_SLOT_PATTERN = '([^']+)';/);
  const ciRigPatternMatch = ciRigSource.match(/SLOT_ID_PATTERN='([^']+)'/);

  it('is scanning files that still declare the pattern (non-vacuity guard)', () => {
    expect(devRigPatternMatch).not.toBeNull();
    expect(ciRigPatternMatch).not.toBeNull();
  });

  /**
   * The two copies are hand-maintained in different languages, so nothing but
   * this assertion enforces the "keep this identical to dev.mjs" comment each
   * one carries. It is deliberately paired with the derivation checks below:
   * agreeing with each other proves nothing if both have drifted away from
   * what the app dials.
   */
  it('scripts/dev.mjs and .github/scripts/run-maestro-paired.sh declare the SAME pattern', () => {
    expect(ciRigPatternMatch![1]).toBe(devRigPatternMatch![1]);
  });

  const rigPatterns = [
    { name: 'scripts/dev.mjs', match: devRigPatternMatch },
    { name: '.github/scripts/run-maestro-paired.sh', match: ciRigPatternMatch },
  ];

  for (const { name, match } of rigPatterns) {
    it(`${name} accepts a derived pairing slot`, () => {
      const relaySlotPattern = new RegExp(match![1]);
      const pairingSlot = derivePairingSlotId(randomBytes(32));
      expect(pairingSlot).toMatch(relaySlotPattern);
    });

    it(`${name} accepts a derived session slot`, () => {
      const relaySlotPattern = new RegExp(match![1]);
      const sessionSlot = deriveSessionSlotId(generateX25519KeyPair().publicKey, generateX25519KeyPair().publicKey);
      expect(sessionSlot).toMatch(relaySlotPattern);
    });
  }
});
