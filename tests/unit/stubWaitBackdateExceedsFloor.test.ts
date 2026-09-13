/**
 * `scripts/stubDesktopPeer.mjs` backdates its emitted `reason.since` so the
 * Agents feed's elapsed-wait label has something to show inside a Maestro
 * flow that runs for well under a minute - `WaitLabel` renders nothing below
 * `MINIMUM_VISIBLE_MS` (60s). The stub's own comment says the two values
 * travel together: "Raising that floor past this backdate would break the
 * assertion in .maestro/paired/home-needs-you-approve.yaml". Nothing
 * enforced that promise before this file.
 *
 * Same class of drift, and the same fix, as
 * `mockDesktopFixtures.test.ts`'s "the two banned-vocabulary lists stay in
 * step": a "kept in step" comment is only ever a promise until something
 * reads both sides and compares them.
 *
 * `scripts/stubDesktopPeer.mjs` calls `main()` unconditionally at module
 * scope (parses argv, exits the process on a bad flag, opens a socket to a
 * relay), so importing it as a module is unsafe - the same reasoning
 * `mockDesktopFixtures.test.ts` gives for not importing
 * `buildTerminalFixture.mjs`. Structural source-text extraction instead.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const stubDesktopPeerSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'stubDesktopPeer.mjs'), 'utf8');
const waitLabelSource = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'board', 'WaitLabel.tsx'), 'utf8');

/** The stub's backdate, in ms, from `STUB_WAITING_SINCE_MS`'s hours/minutes literal. */
function extractStubBackdateMs(): number {
  const match = /const STUB_WAITING_SINCE_MS = Date\.now\(\) - (\d+) \* 60 \* 60_000 - (\d+) \* 60_000;/.exec(
    stubDesktopPeerSource,
  );
  expect(match, 'could not find STUB_WAITING_SINCE_MS in stubDesktopPeer.mjs - update this extraction to its new form').not.toBeNull();
  const [, hours, minutes] = match as RegExpExecArray;
  return Number(hours) * 60 * 60_000 + Number(minutes) * 60_000;
}

/** `WaitLabel`'s render-nothing floor, in ms, from `MINIMUM_VISIBLE_MS`'s literal. */
function extractMinimumVisibleMs(): number {
  const match = /const MINIMUM_VISIBLE_MS = ([\d_]+);/.exec(waitLabelSource);
  expect(match, 'could not find MINIMUM_VISIBLE_MS in WaitLabel.tsx - update this extraction to its new form').not.toBeNull();
  return Number((match as RegExpExecArray)[1].replace(/_/g, ''));
}

describe('the stub desktop peer backdates its wait past WaitLabel\'s floor', () => {
  it('finds both literals at all', () => {
    // Non-vacuity guard: a regex that stopped matching either file would
    // otherwise make the comparison below pass on 0 > 0 being false, which
    // reads as "the promise holds" for the wrong reason.
    expect(extractStubBackdateMs()).toBeGreaterThan(0);
    expect(extractMinimumVisibleMs()).toBeGreaterThan(0);
  });

  it('backdates far enough that .maestro/paired/home-needs-you-approve.yaml always has a label to assert', () => {
    expect(extractStubBackdateMs()).toBeGreaterThan(extractMinimumVisibleMs());
  });
});
