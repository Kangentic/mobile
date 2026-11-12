/**
 * scripts/lib/cliArguments.mjs: the strict `--flag value` parser four release
 * scripts share. Those scripts decide what reaches a store, so a malformed
 * command line has to stop before the first call.
 */
import { describe, expect, it } from 'vitest';

import { parseFlagPairs } from '../../scripts/lib/cliArguments.mjs';

describe('parseFlagPairs', () => {
  it('maps each flag, without its dashes, to its value', () => {
    expect(parseFlagPairs(['--key', 'key.json', '--mode', 'check'])).toEqual({ key: 'key.json', mode: 'check' });
    expect(parseFlagPairs([])).toEqual({});
  });

  it('refuses a trailing flag with no value', () => {
    expect(() => parseFlagPairs(['--key', 'key.json', '--mode'])).toThrow('Malformed argument near "--mode".');
  });

  it('refuses a word where a flag belongs', () => {
    expect(() => parseFlagPairs(['mode', 'check'])).toThrow('Malformed argument near "mode".');
    expect(() => parseFlagPairs(['-mode', 'check'])).toThrow('Malformed argument near "-mode".');
  });

  it('refuses a stray extra word, which would shift every later pair out of step', () => {
    expect(() => parseFlagPairs(['--mode', 'check', 'extra', '--key', 'key.json'])).toThrow(
      'Malformed argument near "extra".'
    );
  });

  it('takes the next token as the value even when it looks like a flag', () => {
    // The reason a bare flag is unsupported: it would swallow its neighbour.
    expect(parseFlagPairs(['--await-processing', '--timeout-minutes'])).toEqual({
      'await-processing': '--timeout-minutes',
    });
  });

  it('lets a repeated flag take its last value', () => {
    expect(parseFlagPairs(['--mode', 'check', '--mode', 'sync'])).toEqual({ mode: 'sync' });
  });
});
