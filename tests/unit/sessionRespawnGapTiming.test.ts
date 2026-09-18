/**
 * Guards the timing relationship between the two rigs' respawn gaps and the
 * phone's own swap-window timeout, none of which reference each other in
 * code - only in prose. `scripts/stubDesktopPeer.mjs`'s own docblock says it
 * outright: "Two other numbers are coupled to this one with nothing to
 * enforce it." This is that enforcement.
 *
 * Three constants, three files, no shared import (one is a plain .mjs rig
 * script, one is the mock desktop, one is the screen that consumes both):
 *
 * - `STUB_RESPAWN_GAP_MS` (scripts/stubDesktopPeer.mjs) - how long the
 *   Maestro rig holds a task sessionless during `/respawn` before installing
 *   the successor.
 * - `MOCK_RESPAWN_GAP_MS` (src/connection/mockDesktop.ts) - the same gap for
 *   the dev:mock rig, kept equal "by convention" per both files' comments so
 *   dev:mock and E2E show the same thing.
 * - `SESSION_SWAP_GRACE_MS` (src/screens/task/SessionScreen.tsx) - how long
 *   the phone waits for a successor before giving up and declaring the
 *   session dead.
 * - `SESSION_SWAP_QUIET_MS` (same file) - how long a swap stays SILENT (the
 *   veil, no text) before the switching or ended surface may reveal. A rig
 *   swap must finish inside it, or dev:mock and E2E would show the long-gap
 *   text on every run; and it must leave a text phase before the grace
 *   fallback, or the switching surface could never show at all.
 *
 * Two failure modes this closes, both silent without it:
 *
 * 1. A rig gap widened (or the phone's grace window narrowed) until the gap
 *    exceeds the grace window: the phone would give up and show "Session
 *    ended" mid-respawn on every dev:mock/E2E run - the exact regression
 *    task #75 fixed, reintroduced by a values-only edit that touches no
 *    logic and trips no other test.
 * 2. A rig gap narrowed toward zero: the "Switching session" overlay is
 *    visible for only the gap's duration, and `.maestro/paired/`
 *    `session-respawn-recovery.yaml`'s own TRIAGE NOTE names the resulting
 *    failure mode - a starved emulator's first poll can land after the
 *    successor has already bound, reading as a real regression when it is
 *    only a timing squeeze. A floor keeps the transient window wide enough
 *    to survive that.
 *
 * Deliberately regex-extraction over importing the values: the .mjs script
 * exports nothing (see scripts/stubDesktopPeer.mjs's module-level comments),
 * and mockDesktop.ts's constant is module-private. Same technique as
 * `tests/unit/ciSafeMaestroFlows.test.ts`'s MAESTRO_VERSION cross-check and
 * `tests/unit/maestroFlows.test.ts`'s timeout scan, including their
 * non-vacuity guards - a regex that silently stops matching would leave
 * every comparison below vacuously true.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const stubDesktopPeerSource = readFileSync(`${repositoryRoot}scripts/stubDesktopPeer.mjs`, 'utf8');
const mockDesktopSource = readFileSync(`${repositoryRoot}src/connection/mockDesktop.ts`, 'utf8');
const sessionScreenSource = readFileSync(`${repositoryRoot}src/screens/task/SessionScreen.tsx`, 'utf8');
const activityStoreSource = readFileSync(`${repositoryRoot}src/state/activityStore.ts`, 'utf8');

/** Reads a `const NAME = 1_234;`-shaped numeric literal, underscores and all. */
function readNumericConstant(source: string, constantName: string): number | null {
  const match = new RegExp(`const ${constantName}\\s*=\\s*([\\d_]+)`).exec(source);
  if (match === null) return null;
  return Number(match[1].replace(/_/g, ''));
}

const stubRespawnGapMs = readNumericConstant(stubDesktopPeerSource, 'STUB_RESPAWN_GAP_MS');
const mockRespawnGapMs = readNumericConstant(mockDesktopSource, 'MOCK_RESPAWN_GAP_MS');
const sessionSwapGraceMs = readNumericConstant(sessionScreenSource, 'SESSION_SWAP_GRACE_MS');
const sessionSwapQuietMs = readNumericConstant(sessionScreenSource, 'SESSION_SWAP_QUIET_MS');
const respawnRowGraceMs = readNumericConstant(activityStoreSource, 'RESPAWN_ROW_GRACE_MS');
const endedRowGraceMs = readNumericConstant(activityStoreSource, 'ENDED_ROW_GRACE_MS');

describe('the respawn-gap and swap-grace constants stay in the relationship the comments claim', () => {
  it('finds all six constants (a silent extraction failure would make every comparison below vacuous)', () => {
    expect(stubRespawnGapMs).not.toBeNull();
    expect(mockRespawnGapMs).not.toBeNull();
    expect(sessionSwapGraceMs).not.toBeNull();
    expect(sessionSwapQuietMs).not.toBeNull();
    expect(respawnRowGraceMs).not.toBeNull();
    expect(endedRowGraceMs).not.toBeNull();
  });

  /**
   * The list surfaces and the session screen claim ONE window each, in prose
   * ("deliberately the same 20s", "equal to SESSION_SWAP_QUIET_MS"). A user
   * glancing between the feed and the session screen must see one swap, not
   * a row that outlives the veil or a veil that outlives the row.
   */
  it('keeps the list surfaces on the same two windows as the session screen', () => {
    expect(respawnRowGraceMs).toBe(sessionSwapGraceMs);
    expect(endedRowGraceMs).toBe(sessionSwapQuietMs);
  });

  it('keeps every rig swap inside the quiet window, so a rig respawn never reveals the long-gap text', () => {
    // 2000ms of headroom: the gap is the desktop side of the swap, and the
    // phone's own bind-to-paint round trip lands on top of it.
    const requiredHeadroomMs = 2000;
    expect(stubRespawnGapMs).toBeLessThanOrEqual((sessionSwapQuietMs as number) - requiredHeadroomMs);
    expect(mockRespawnGapMs).toBeLessThanOrEqual((sessionSwapQuietMs as number) - requiredHeadroomMs);
  });

  it('leaves a text phase between the quiet deadline and the ended fallback', () => {
    // Without this the switching surface could never show: the grace
    // fallback would land before (or with) the reveal.
    const requiredTextPhaseMs = 5000;
    expect(sessionSwapQuietMs).toBeLessThanOrEqual((sessionSwapGraceMs as number) - requiredTextPhaseMs);
  });

  it("the stub rig's gap matches the mock rig's, as both files' comments claim", () => {
    // Neither rig imports the other's constant - "the two rigs share no
    // code" per both docblocks - so this is the only thing that would catch
    // one of them drifting while the other stays put.
    expect(stubRespawnGapMs).toBe(mockRespawnGapMs);
  });

  it('leaves real headroom between the respawn gap and the phone giving up', () => {
    // Both rig docblocks state the requirement in words ("comfortably short
    // of / well below the phone's session-swap grace window"); this is that
    // requirement as a number. 5000ms of headroom is deliberately more than
    // the smallest gap that would technically still close before the grace
    // window expires: a gap that merely EQUALS the grace window minus one
    // tick is still a real regression risk on a slow desktop, not a margin.
    const requiredHeadroomMs = 5000;
    expect(sessionSwapGraceMs).not.toBeNull();
    expect(stubRespawnGapMs).not.toBeNull();
    expect(mockRespawnGapMs).not.toBeNull();
    expect(stubRespawnGapMs).toBeLessThanOrEqual((sessionSwapGraceMs as number) - requiredHeadroomMs);
    expect(mockRespawnGapMs).toBeLessThanOrEqual((sessionSwapGraceMs as number) - requiredHeadroomMs);
  });

  it('keeps the respawn gap long enough for the transient window to survive a slow poll', () => {
    // The Maestro flow's own TRIAGE NOTE names the failure this floor
    // prevents: a starved emulator's first poll for "session-switching-state"
    // can land after the successor has already bound, burning the full
    // extendedWaitUntil timeout and reading as the regression this whole
    // feature exists to fix. A gap driven toward zero makes that increasingly
    // likely regardless of how the wait itself is tuned - a longer wait
    // cannot see a state that has already passed, per that same note. 3000ms
    // is a guard against a near-zero value, not a measured Maestro polling
    // cadence (this repo does not claim one - see
    // performance-claims-are-measured.md); it exists so a values-only edit
    // that shrinks the gap toward zero fails here instead of as an
    // intermittent, hard-to-reproduce E2E flake.
    const minimumObservableGapMs = 3000;
    expect(stubRespawnGapMs).toBeGreaterThanOrEqual(minimumObservableGapMs);
  });
});
