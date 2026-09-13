/**
 * Must be the first import in the JS bundle that touches
 * @kangentic/protocol (see index.js). Hermes has no global
 * crypto.getRandomValues, which @noble/* (the protocol's crypto primitives)
 * calls synchronously at key-generation time, and no TextDecoder (only
 * TextEncoder, added separately). Importing this file after protocol code
 * has already loaded is too late - keygen throws.
 *
 * `src/devsupport/connectionTrace` precedes this one in index.js - it is a
 * zero-import leaf that touches nothing crypto- or protocol-related, so it
 * does not disturb the ordering guarantee above; it exists first only so
 * its own module evaluation can serve as the cold-launch clock origin.
 */
import { traceConnection } from '@/devsupport/connectionTrace';
import 'react-native-get-random-values';
import '@bacons/text-decoder/install';
import { generateX25519KeyPair } from '@kangentic/protocol';

function assertCryptoPolyfilled(): void {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error(
      'crypto.getRandomValues is unavailable: react-native-get-random-values did not install correctly, or cryptoPolyfills was imported after code that already touched crypto.',
    );
  }
  if (typeof globalThis.TextEncoder !== 'function' || typeof globalThis.TextDecoder !== 'function') {
    throw new Error(
      'TextEncoder/TextDecoder are unavailable: @bacons/text-decoder did not install correctly, or cryptoPolyfills was imported too late.',
    );
  }
}

assertCryptoPolyfilled();
traceConnection('polyfills-ready');

if (__DEV__) {
  // Proves the polyfills actually work end to end on the running engine, not
  // just that the globals exist - catches a regression where getRandomValues
  // is present but non-functional, before it surfaces as a confusing
  // handshake failure deep in the pairing flow.
  const probeKeyPair = generateX25519KeyPair();
  if (probeKeyPair.publicKey.length !== 32) {
    throw new Error('Crypto self-check failed: generateX25519KeyPair() did not return a 32-byte public key.');
  }
  const decoded = new TextDecoder().decode(new TextEncoder().encode('kangentic'));
  if (decoded !== 'kangentic') {
    throw new Error('Crypto self-check failed: TextEncoder/TextDecoder did not round-trip correctly.');
  }
}
