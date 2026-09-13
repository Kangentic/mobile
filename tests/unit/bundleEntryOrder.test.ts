/**
 * `src/devsupport/connectionTrace`'s module evaluation IS the cold-launch
 * clock origin the connection trace measures from (see its docstring and
 * docs/developer-guide.md's cold-launch section). That correctness is
 * purely POSITIONAL: it only works while the module is the very first
 * import `index.js` evaluates. Nothing else in the suite would notice a
 * reorder - it would silently invalidate every future cold-start number
 * without breaking a single other test - so this file exists to pin the
 * position directly against the real bundle-entry file.
 *
 * It pins the SECOND half of that coupling too. Putting connectionTrace
 * first moved it above `react-native-get-random-values`, so the crypto
 * polyfills now install after it. That is safe only while connectionTrace
 * imports nothing at all: an import reaching @kangentic/protocol or @noble/*
 * would evaluate crypto code before the polyfills and throw at keygen on
 * cold launch. Position alone does not catch that, so leafness is asserted
 * directly.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Reads the real files rather than a copy, so a future edit cannot drift
 * from what these tests actually check.
 */
function readRepositoryFile(relativePath: string): string {
  return readFileSync(`${repositoryRoot}${relativePath}`, 'utf8');
}

function readIndexImportSpecifiers(): string[] {
  const indexSource = readRepositoryFile('index.js');
  return [...indexSource.matchAll(/^import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"];/gm)].map((match) => match[1]);
}

describe('index.js bundle-entry order', () => {
  /**
   * Mutation seen failing: reordering index.js so
   * `import './src/lib/cryptoPolyfills';` came first made this fail -
   * "expected './src/lib/cryptoPolyfills' to be
   * './src/devsupport/connectionTrace'".
   */
  it('connectionTrace is the first import', () => {
    const importSpecifiers = readIndexImportSpecifiers();

    expect(importSpecifiers.length).toBeGreaterThan(0);
    expect(importSpecifiers[0]).toBe('./src/devsupport/connectionTrace');
  });

  /**
   * Every entry import after cryptoPolyfills reaches @kangentic/protocol:
   * './src/observability/crashReporting' imports it directly, './src/notifications'
   * reaches it through pushKeys/pushDecrypt/pushRegistration, and
   * 'expo-router/entry' pulls in the whole app. So the assertion is not
   * "precedes expo-router/entry" (which a reorder could satisfy while still
   * loading protocol code first) but "precedes EVERY later entry import" -
   * i.e. nothing but connectionTrace may sit ahead of it.
   *
   * Mutation seen failing: moving `import { initializeNotifications } from
   * './src/notifications';` above `import './src/lib/cryptoPolyfills';` in
   * index.js made this fail - "expected 2 to be 1" on the cryptoPolyfills
   * index. The earlier spelling of this test (cryptoPolyfillsIndex <
   * expoRouterEntryIndex) stayed GREEN on that same mutation, 2 < 4, which
   * is why the assertion is pinned to the position rather than to a pairwise
   * comparison.
   */
  it('src/lib/cryptoPolyfills precedes every entry import that can reach @kangentic/protocol', () => {
    const importSpecifiers = readIndexImportSpecifiers();
    const cryptoPolyfillsIndex = importSpecifiers.indexOf('./src/lib/cryptoPolyfills');

    expect(cryptoPolyfillsIndex).toBe(1);
    expect(importSpecifiers).toContain('expo-router/entry');
    // Nothing ahead of it but the zero-import clock origin.
    expect(importSpecifiers.slice(0, cryptoPolyfillsIndex)).toEqual(['./src/devsupport/connectionTrace']);
  });

  /**
   * The leafness half of the coupling. connectionTrace evaluates BEFORE the
   * Hermes crypto polyfills (it is index.js's first import, and
   * cryptoPolyfills imports it above its own side-effect imports), so any
   * import it gains that transitively reaches @kangentic/protocol or
   * @noble/* would run keygen-capable code with no getRandomValues installed
   * and throw at cold launch. Asserted against the source text rather than
   * the module graph so the check cannot be satisfied by a mock.
   *
   * Mutation seen failing: adding `import { bytesToHex } from
   * '@kangentic/protocol';` to connectionTrace.ts made this fail -
   * "expected [ \"import { bytesToHex } from '@kangentic/protocol';\" ] to
   * deeply equal []".
   */
  it('src/devsupport/connectionTrace has no imports at all', () => {
    const traceSource = readRepositoryFile('src/devsupport/connectionTrace.ts');
    // Strip block and line comments first: the file's own docstrings discuss
    // importing at length, and a reflow could otherwise start a comment line
    // with the word "import" and fail this vacuously.
    const withoutComments = traceSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const importStatements = [...withoutComments.matchAll(/^\s*import\b.*$/gm)].map((match) => match[0].trim());
    const dynamicImports = [...withoutComments.matchAll(/\bimport\s*\(/g)].map((match) => match[0]);
    const requireCalls = [...withoutComments.matchAll(/\brequire\s*\(/g)].map((match) => match[0]);

    expect(importStatements).toEqual([]);
    expect(dynamicImports).toEqual([]);
    expect(requireCalls).toEqual([]);
  });
});
