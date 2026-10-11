/**
 * `scripts/stubDesktopPeer.mjs` gained a `/refuse-stream on|off` magic composer
 * command for `.maestro/paired/session-refused-subscribe.yaml`. Two promises
 * around it were enforced by nothing:
 *
 * 1. The per-flow reset (`resetStubFixture`) clears the three flags the command
 *    drives. Its own comment says why: "A flow that ends with refusals still on
 *    would otherwise refuse every subscribe of the next one, which reads as a
 *    broken session screen." The flow sends `/refuse-stream off` itself, so
 *    deleting the resets leaves it green and the contamination only shows up in
 *    whichever flow runs next.
 * 2. The recovery marker the stub appends ("Stream subscribe accepted after N
 *    refusals.") must keep matching the regex the flow waits for. A reword of
 *    either side breaks the flow at its 25s timeout, which reads as a product
 *    regression.
 *
 * `scripts/stubDesktopPeer.mjs` calls `main()` unconditionally at module scope
 * (parses argv, exits the process on a bad flag, opens a socket to a relay), so
 * importing it as a module is unsafe - the same reasoning
 * `stubWaitBackdateExceedsFloor.test.ts` gives. Structural source-text
 * extraction instead.
 *
 * The anchors are structural (the function declaration, the `text:` template
 * that interpolates the refusal count, an inline-string `visible:`), never the
 * words under test, so rewording the marker fails on the comparison below and
 * not on a "could not find" guard.
 *
 * Mutations seen failing (2026-10-11):
 * - Deleting `recoveryMarkerPending = false;` from `resetStubFixture` (the same
 *   assignment still exists in the `/refuse-stream on` handler, which is why
 *   the assertions are scoped to the extracted body):
 *   "resetStubFixture must reset recoveryMarkerPending: expected
 *   '      boardMutations.patches.clear();...' to match
 *   /^\s*recoveryMarkerPending = false;\s*$/m" (only that one test went red)
 * - Rewording the marker to "Stream subscribe acceptd after ...":
 *   "expected 'Stream subscribe acceptd after 4 refu...' to match
 *   /^(?:Stream subscribe accepted after [1-9].*)$/" (only the 4-refusals
 *   test went red)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const stubDesktopPeerSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'stubDesktopPeer.mjs'), 'utf8');
const refusedSubscribeFlowSource = readFileSync(
  join(__dirname, '..', '..', '.maestro', 'paired', 'session-refused-subscribe.yaml'),
  'utf8',
);

/** The three per-session flags the `/refuse-stream` command drives, with the value each resets to. */
const REFUSE_STREAM_FLAG_RESETS = [
  { name: 'refuseStreamSubscribes', resetValue: 'false' },
  { name: 'refusedStreamSubscribeCount', resetValue: '0' },
  { name: 'recoveryMarkerPending', resetValue: 'false' },
] as const;

/** The body of `resetStubFixture`, from its declaration to its closing brace at the same indentation. */
function extractResetStubFixtureBody(): string {
  const match = /\r?\n( +)function resetStubFixture\(\) \{\r?\n([\s\S]*?)\r?\n\1\}\r?\n/.exec(stubDesktopPeerSource);
  expect(match, 'could not find resetStubFixture in stubDesktopPeer.mjs - update this extraction to its new form').not.toBeNull();
  return (match as RegExpExecArray)[2];
}

/**
 * The marker the stub appends once a subscribe is accepted after `off`,
 * rendered for a given refusal count. The template is the `text:` literal that
 * interpolates the count, split around the interpolation.
 */
function renderStubRecoveryMarker(refusalCount: number): string {
  const match = /text: `([^`$]*)\$\{refusedStreamSubscribeCount\}([^`]*)`/.exec(stubDesktopPeerSource);
  expect(match, 'could not find the recovery marker template in stubDesktopPeer.mjs - update this extraction to its new form').not.toBeNull();
  const [, markerHead, markerTail] = match as RegExpExecArray;
  return `${markerHead}${refusalCount}${markerTail}`;
}

/**
 * The flow's marker wait, as the RegExp Maestro applies. Maestro's text
 * matcher is full-string, so the pattern is anchored the same way here.
 */
function extractFlowMarkerPattern(): RegExp {
  const match = /^\s*visible:\s*"([^"]+)"\s*$/m.exec(refusedSubscribeFlowSource);
  expect(match, 'could not find an inline-string `visible:` in session-refused-subscribe.yaml - update this extraction to its new form').not.toBeNull();
  return new RegExp(`^(?:${(match as RegExpExecArray)[1]})$`);
}

describe('the stub resets the /refuse-stream state between flows', () => {
  it('declares the three flags the reset is supposed to clear', () => {
    // Non-vacuity guard: a renamed flag would otherwise make the reset checks
    // below look for a name that no longer exists and fail for that reason, or
    // (worse) pass against a stale name left in a comment.
    for (const { name } of REFUSE_STREAM_FLAG_RESETS) {
      expect(stubDesktopPeerSource, `${name} is no longer declared in stubDesktopPeer.mjs`).toMatch(
        new RegExp(`^\\s*let ${name} = (?:false|0);\\s*$`, 'm'),
      );
    }
  });

  it('extracts the function it thinks it does', () => {
    // A sibling reset that predates /refuse-stream: proves the extraction
    // captured resetStubFixture's body and not some other block.
    expect(extractResetStubFixtureBody()).toMatch(/^\s*codexStreamSubscribed = false;\s*$/m);
  });

  for (const { name, resetValue } of REFUSE_STREAM_FLAG_RESETS) {
    it(`resetStubFixture clears ${name}`, () => {
      // Scoped to the extracted body: each flag is also assigned in the
      // `/refuse-stream on|off` handler and declared with the same value, so a
      // file-wide search would stay green with the reset deleted.
      expect(
        extractResetStubFixtureBody(),
        `resetStubFixture must reset ${name}`,
      ).toMatch(new RegExp(`^\\s*${name} = ${resetValue};\\s*$`, 'm'));
    });
  }
});

describe('the stub\'s recovery marker keeps matching session-refused-subscribe.yaml', () => {
  it('matches the flow\'s wait when at least one subscribe was refused', () => {
    expect(renderStubRecoveryMarker(4)).toMatch(extractFlowMarkerPattern());
  });

  it('does not match when no subscribe was refused, so a toggle that never fired cannot pass the flow', () => {
    expect(renderStubRecoveryMarker(0)).not.toMatch(extractFlowMarkerPattern());
  });
});
