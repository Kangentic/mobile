/**
 * Covers the mock desktop's FIXTURE CONTENT, not its wire behaviour.
 *
 * These fixtures are the source for every committed store screenshot
 * (scripts/storeScreenshots.mjs, .maestro/screenshots/store-capture.yaml), so
 * they are published to the App Store, to Play, and to a public repo, captioned
 * as a customer using the product. That makes their text a product claim rather
 * than test data, and it is the one part of this repo where being wrong is
 * invisible to every other check: a frame with the wrong words in it is still
 * the right pixel size, still named correctly, and still verifies.
 *
 * Two things went wrong before these tests existed, both caught only by a human
 * looking at a PNG:
 *
 *  1. Cards describing KANGENTIC'S OWN backlog shipped as the fictional
 *     customer's work - the register-push capability migration, the relay
 *     self-host guide, the terminal font-fit heuristic, and a flaky pairing
 *     flow whose body text read "the QR-scan step races the relay handshake".
 *  2. The terminal frame and the changes frame described DIFFERENT work: the
 *     terminal edited `src/router/index.ts`, which appears in no diff the
 *     Changes lens lists, and reported line counts that did not add up to what
 *     the file list claimed for the file it did edit.
 */
import { describe, expect, it } from 'vitest';

import {
  MOCK_CONTEXT_WINDOW_FOR_TEST,
  MOCK_EXTRA_THINKING_SESSIONS,
  MOCK_STREAM_CEILING_FOR_TEST,
  MOCK_TERMINAL_LINES,
  diffFileList,
  initialTasks,
  initialTasks2,
  streamingUsedTokens,
} from '@/connection/mockDesktop';

/**
 * Vocabulary that only Kangentic's own engineering would use.
 *
 * Deliberately the product's domain nouns rather than a list of the specific
 * sentences that leaked: re-listing those would pass the moment someone writes
 * a NEW card about our own work, which is the actual failure mode.
 */
const KANGENTIC_DOMAIN_TERMS = [
  'relay',
  'pairing',
  'paired',
  'noise',
  'maestro',
  'expo',
  'react native',
  'capability',
  'register-push',
  'push token',
  'push-notification',
  'pty',
  'scrollback',
  'sas',
  'qr',
];

/** Every string these fixtures put on screen. */
function renderedFixtureText(): { label: string; text: string }[] {
  const collected: { label: string; text: string }[] = [];
  for (const task of [...initialTasks(), ...initialTasks2()]) {
    collected.push({ label: `task ${task.id} title`, text: task.title });
    if (task.description) collected.push({ label: `task ${task.id} description`, text: task.description });
    if (task.branch_name) collected.push({ label: `task ${task.id} branch`, text: task.branch_name });
    for (const label of task.labels ?? []) collected.push({ label: `task ${task.id} label`, text: label });
  }
  for (const spec of MOCK_EXTRA_THINKING_SESSIONS) {
    collected.push({ label: `${spec.sessionId} title`, text: spec.title });
    collected.push({ label: `${spec.sessionId} user`, text: spec.userText });
    collected.push({ label: `${spec.sessionId} assistant`, text: spec.assistantText });
  }
  for (const line of MOCK_TERMINAL_LINES) collected.push({ label: 'terminal line', text: line });
  return collected;
}

describe('the mock fixtures stay inside the customer fiction', () => {
  it('collects a non-trivial amount of text to check', () => {
    // Non-vacuity guard: every assertion below passes trivially against an
    // empty list, so a refactor that stopped collecting would read as a pass.
    const collected = renderedFixtureText();
    expect(collected.length).toBeGreaterThan(30);
    expect(collected.some((entry) => entry.text.includes('sign-in redirect'))).toBe(true);
  });

  it.each(KANGENTIC_DOMAIN_TERMS)('never says "%s" in anything it renders', (term) => {
    // Whole words only. A plain substring match reads "exposes" as "expo" and
    // "sassy" as "sas", and a check that cries wolf gets deleted.
    const wordPattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const offenders = renderedFixtureText()
      .filter((entry) => wordPattern.test(entry.text))
      .map((entry) => `${entry.label}: ${entry.text}`);
    expect(offenders).toEqual([]);
  });
});

describe('the terminal frame and the changes frame describe one piece of work', () => {
  /** Every `(+N -M)` the terminal script reports, in order. */
  function terminalEditCounts(): { insertions: number; deletions: number }[] {
    return MOCK_TERMINAL_LINES.flatMap((line) => {
      const match = /\(\+(\d+) -(\d+)\)/.exec(line);
      return match ? [{ insertions: Number(match[1]), deletions: Number(match[2]) }] : [];
    });
  }

  it('reports at least one edit, so the sum below is not vacuous', () => {
    expect(terminalEditCounts().length).toBeGreaterThan(0);
  });

  it('only edits files the Changes lens actually lists', () => {
    const listedPaths = diffFileList().files.map((file) => file.path);
    const editedPaths = MOCK_TERMINAL_LINES.flatMap((line) => {
      const match = /^> Editing (\S+)/.exec(line);
      return match ? [match[1]] : [];
    });
    expect(editedPaths.length).toBeGreaterThan(0);
    for (const editedPath of editedPaths) {
      expect(listedPaths).toContain(editedPath);
    }
  });

  it("sums the terminal's edits to what the file list claims for login.ts", () => {
    // Both frames ship in the same listing, one swipe apart, and a reviewer
    // comparing them is exactly what a screenshot invites.
    const loginFile = diffFileList().files.find((file) => file.path === 'src/auth/login.ts');
    expect(loginFile).toBeDefined();
    const totals = terminalEditCounts().reduce(
      (accumulated, edit) => ({
        insertions: accumulated.insertions + edit.insertions,
        deletions: accumulated.deletions + edit.deletions,
      }),
      { insertions: 0, deletions: 0 },
    );
    expect(totals.insertions).toBe(loginFile?.insertions);
    expect(totals.deletions).toBe(loginFile?.deletions);
  });
});

describe('the streaming context bar stays out of alarm red', () => {
  it('clamps however long the capture runs', () => {
    // The capture takes longer than the bar took to fill at the original rate,
    // so the board and feed frames - taken last - showed a maxed-out context
    // window in red. Real state, wrong thing for a listing to assert.
    expect(streamingUsedTokens(1_000_000)).toBe(MOCK_STREAM_CEILING_FOR_TEST);
  });

  it('leaves the ceiling comfortably below the danger threshold', () => {
    const usedFraction = MOCK_STREAM_CEILING_FOR_TEST / MOCK_CONTEXT_WINDOW_FOR_TEST;
    expect(usedFraction).toBeLessThan(0.75);
  });

  it('still visibly advances, which is the whole demo', () => {
    expect(streamingUsedTokens(10)).toBeGreaterThan(streamingUsedTokens(0));
  });
});
