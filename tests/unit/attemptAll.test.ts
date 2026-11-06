/**
 * Covers src/lib/attemptAll.ts: a wipe runs every step even when one fails, then
 * rejects with the FIRST failure. Until now it was only reached through
 * TrustAnchorStore.clear and clearPushRegistration, each with a single failure,
 * so neither could tell "first" from "last" or "keeps going" from "stops".
 */
import { describe, expect, it } from 'vitest';

import { attemptAll } from '../../src/lib/attemptAll';

describe('attemptAll', () => {
  it('resolves when every step passes, running them in order', async () => {
    const ran: string[] = [];
    const steps = ['first', 'second', 'third'].map((name) => async () => {
      ran.push(name);
    });

    await expect(attemptAll(steps)).resolves.toBeUndefined();
    expect(ran).toEqual(['first', 'second', 'third']);
  });

  it('rejects with the FIRST failure, and every step after each failure still runs', async () => {
    const ran: string[] = [];
    const firstError = new Error('first failure');
    const secondError = new Error('second failure');
    const steps = [
      async () => {
        ran.push('a');
        throw firstError;
      },
      async () => {
        ran.push('b');
      },
      async () => {
        ran.push('c');
        throw secondError;
      },
      async () => {
        ran.push('d');
      },
    ];

    await expect(attemptAll(steps)).rejects.toBe(firstError);
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
  });

  it('catches a step that throws synchronously, still runs later steps, and rejects with that error', async () => {
    const ran: string[] = [];
    const syncError = new Error('threw before returning a promise');
    const steps = [
      (): Promise<unknown> => {
        ran.push('sync');
        throw syncError;
      },
      async () => {
        ran.push('after');
      },
    ];

    await expect(attemptAll(steps)).rejects.toBe(syncError);
    expect(ran).toEqual(['sync', 'after']);
  });

  it('resolves for an empty list', async () => {
    await expect(attemptAll([])).resolves.toBeUndefined();
  });
});
