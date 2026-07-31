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
import { beforeAll, describe, expect, it } from 'vitest';

import {
  MOCK_CONTEXT_WINDOW_FOR_TEST,
  MOCK_EXTRA_THINKING_SESSIONS,
  MOCK_STREAM_CEILING_FOR_TEST,
  activeCapture,
  activeGrid,
  baseTranscriptForTest,
  diffFileContent,
  diffFileList,
  initialTasks,
  initialTasks2,
  streamingUsedTokens,
} from '@/connection/mockDesktop';
import { CLAUDE_CAPTURE_SHOTS } from '@/devsupport/claudeCapture';
import { renderCaptureAllRows, renderCaptureRows } from '../helpers/renderCapture';

/**
 * The terminal fixture is now a RECORDED capture of real Claude Code output,
 * so nothing about it can be read off a source array any more. Everything below
 * renders it through a headless xterm at its own grid and asserts on the cells
 * the user would actually see - which is also the only way to be sure, because
 * a TUI's bytes and its screen are not the same thing.
 */
let shotsRows: string[] = [];
/** Every row the capture shows at ANY point, not just on its closing frame. */
let shotsEveryRow: string[] = [];

beforeAll(async () => {
  shotsRows = await renderCaptureRows(CLAUDE_CAPTURE_SHOTS);
  shotsEveryRow = await renderCaptureAllRows(CLAUDE_CAPTURE_SHOTS);
});

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
  // The product's own NAME. scripts/buildTerminalFixture.mjs bans it at
  // capture-build time and its comment says that list is "kept in step" with
  // this one, but this list never carried it - so the single most obvious
  // giveaway in a fixture published to the App Store was the one word the
  // review-time half of the guard did not look for.
  'kangentic',
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
  // The recorded terminal, as RENDERED. Both captures are checked, not just the
  // one the store capture uses: `dev:mock` is what gets demoed live, and a leak
  // there is a leak in front of whoever is watching.
  for (const row of shotsEveryRow) {
    collected.push({ label: 'terminal row', text: row });
  }
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
  /**
   * Files the recorded session is seen touching, from its `● Edit(path)` /
   * `● Update(path)` / `● Write(path)` tool bullets.
   *
   * Real Claude Code prints the path with the platform separator, so this
   * normalizes backslashes; the wire paths in diffFileList are POSIX.
   */
  function editedPathsIn(rows: string[]): string[] {
    return rows.flatMap((row) => {
      const match = /[●⏺]\s*(?:Edit|Update|Write)\(([^)]+)\)/.exec(row);
      return match ? [match[1].replace(/\\/g, '/')] : [];
    });
  }

  it('shows the agent editing files, so the check below is not vacuous', () => {
    expect(editedPathsIn(shotsEveryRow).length).toBeGreaterThan(0);
  });

  it('only edits files the Changes lens actually lists', () => {
    // Both frames ship in the same listing, one swipe apart, and a reviewer
    // comparing them is exactly what a screenshot invites. This used to fail
    // in the other direction: the terminal edited a file that appeared in no
    // diff the Changes lens listed.
    const listedPaths = diffFileList().files.map((file) => file.path);
    for (const editedPath of editedPathsIn(shotsEveryRow)) {
      expect(listedPaths).toContain(editedPath);
    }
  });

  it('lists exactly the files the recorded session changed', () => {
    // diffFileList is transcribed from the same session's `git diff --numstat`,
    // so a re-record that forgets to regenerate it shows up here.
    expect(diffFileList().files.map((file) => file.path)).toEqual([
      'src/auth/login.ts',
      'src/auth/session.ts',
      'src/components/SignInForm.tsx',
      'src/routes/checkout.tsx',
    ]);
    expect(diffFileList().files.map((file) => [file.insertions, file.deletions])).toEqual([
      [2, 2],
      [10, 2],
      [3, 3],
      [3, 1],
    ]);
  });

  it('totals its own per-file counts', () => {
    const files = diffFileList().files;
    const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    expect(insertions).toBe(diffFileList().totalInsertions);
    expect(deletions).toBe(diffFileList().totalDeletions);
  });
});

/**
 * The THIRD pairing, and the one nothing pinned until now.
 *
 * The terminal-versus-changes checks above exist because those two frames
 * disagreed once. The chat lens is the same hazard with a wider blast radius:
 * `ToolCallCard` renders an Edit's `new_string` and the first 20 lines of a
 * Write's `content` verbatim, so the chat frame puts the edited file on screen
 * in full, one swipe from the Changes frame showing the same file. Both ship in
 * the same store listing.
 *
 * Both directions of this were broken when the check was written: the Edit
 * declared `loginRedirect(path?: string)` where the diff had `path: string`,
 * and the Write named `DEFAULT_DESTINATION` / `isSafeReturnPath` where the diff
 * named `DEFAULT_AFTER_SIGN_IN` / `isInternalPath` - a helper the chat frame
 * called and the diff frame never defined.
 *
 * `diffFileContent` is the anchor, not the transcript: it is transcribed from
 * the recorded session's own `git diff`, and its per-file line counts are
 * checked against `diffFileList` above.
 */
describe('the chat frame and the changes frame describe one edit', () => {
  /** The fictional workspace every tool input is rooted at. */
  const WORKSPACE_ROOT = 'C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\';

  interface FileWritingToolCall {
    readonly uuid: string;
    readonly toolName: string;
    readonly wirePath: string;
    readonly input: Record<string, unknown>;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** Every Edit/Write in the transcript, with its absolute path reduced to the wire path. */
  function fileWritingToolCalls(): FileWritingToolCall[] {
    const collected: FileWritingToolCall[] = [];
    for (const entry of baseTranscriptForTest()) {
      if (entry.kind !== 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type !== 'tool_use') continue;
        if (block.name !== 'Edit' && block.name !== 'Write') continue;
        if (!isRecord(block.input) || typeof block.input.file_path !== 'string') continue;
        collected.push({
          uuid: entry.uuid,
          toolName: block.name,
          wirePath: block.input.file_path.replace(WORKSPACE_ROOT, '').replace(/\\/g, '/'),
          input: block.input,
        });
      }
    }
    return collected;
  }

  it('finds the transcript file-writing calls at all', () => {
    // Non-vacuity guard: every assertion below passes trivially against an
    // empty list, so a transcript that stopped editing files would read as
    // success. Pinned to the exact paths, because a new Edit that no diff
    // backs should fail HERE with a readable message.
    expect(fileWritingToolCalls().map((call) => `${call.toolName} ${call.wirePath}`)).toEqual([
      'Edit src/auth/login.ts',
      'Write src/auth/session.ts',
    ]);
  });

  it('only writes files the Changes lens lists', () => {
    const listedPaths = diffFileList().files.map((file) => file.path);
    for (const call of fileWritingToolCalls()) {
      expect(listedPaths).toContain(call.wirePath);
    }
  });

  it('shows the same AFTER text as the diff frame shows for that file', () => {
    // ASYMMETRIC on purpose, and worth stating so nobody reads more into a
    // green run than it earns. The Edit's `new_string` is a hand-authored
    // literal, so this genuinely cross-checks it. The Write's `content` READS
    // `diffFileContent`, so for that entry the comparison is X.includes(X) and
    // cannot fail - the guarantee there is the derivation in the source, which
    // is stronger than any assertion here. What this still catches is someone
    // re-inlining that literal later, which is exactly how it drifted before.
    const mismatched = fileWritingToolCalls().flatMap((call) => {
      const afterText = call.toolName === 'Write' ? call.input.content : call.input.new_string;
      if (typeof afterText !== 'string') {
        return [`${call.uuid}: ${call.toolName} carries no after text`];
      }
      // `includes` rather than equality: an Edit's new_string is one hunk of
      // the file, a Write's content is the whole of it, and both have to be
      // findable verbatim in what the Changes lens renders.
      return diffFileContent(call.wirePath).modified.includes(afterText)
        ? []
        : [`${call.uuid} (${call.toolName} ${call.wirePath}) is not in the diff's modified text:\n${afterText}`];
    });
    // Named individually: a bare count tells whoever broke it nothing, and the
    // disagreement is invisible in every other check.
    expect(mismatched).toEqual([]);
  });

  it('shows the same BEFORE text as the diff frame shows for that file', () => {
    const mismatched = fileWritingToolCalls().flatMap((call) => {
      if (call.toolName !== 'Edit') return [];
      const beforeText = call.input.old_string;
      if (typeof beforeText !== 'string') return [`${call.uuid}: Edit carries no old_string`];
      return diffFileContent(call.wirePath).original.includes(beforeText)
        ? []
        : [`${call.uuid} (${call.wirePath}) is not in the diff's original text:\n${beforeText}`];
    });
    expect(mismatched).toEqual([]);
  });
});

describe('the recorded terminal is real Claude Code, not an authored script', () => {
  it('renders the chrome the app spends its effort handling', () => {
    // The previous fixture was 20 hand-written "> Reading src/auth/login.ts"
    // lines, which exercised none of this - so the terminal lens, the live-tail
    // cleaner and the store screenshots all previewed against chrome that no
    // agent has ever emitted. Each of these is a distinct thing the app parses.
    // Read across every frame of the replay rather than the closing one, so a
    // future re-record that streams (today's capture is a single settled frame)
    // is still measured on everything that scrolls past.
    const session = shotsEveryRow.join('\n');
    expect(session).toMatch(/[●⏺]/); // tool bullets
    expect(session).toMatch(/[╌─]{8}/); // the rules a dialog frames itself with
    expect(session).toMatch(/Do you want to/); // a live permission dialog
    expect(session).toMatch(/❯\s*1\.\s*Yes/); // its numbered options
    expect(session).toMatch(/Esc to cancel · Tab to amend/); // the dialog footer
    // Deliberately NOT asserting every glyph the cleaner knows about. Which
    // chrome is on screen depends on where the replay window sits, and pinning
    // the full vocabulary here made this test a restatement of the window
    // rather than a check that the fixture is real output. The classifier's own
    // coverage of the rest lives in liveTail.test.ts.
  });

  it('closes every frame inside the grid it was recorded at', () => {
    // A row wider than the grid means the capture and the reported dimensions
    // disagree, which renders as borders sliced mid-glyph on the phone.
    for (const row of shotsRows) expect([...row].length).toBeLessThanOrEqual(CLAUDE_CAPTURE_SHOTS.cols);
  });

  it('ends on the approval request the chat lens shows as a permission card', () => {
    const lastMeaningfulRows = shotsRows.filter((row) => row.trim().length > 0).slice(-12).join('\n');
    expect(lastMeaningfulRows).toMatch(/Do you want to/);
  });

  it('is a SETTLED frame, so no arrival time can catch it mid-paint', () => {
    // TIMING, not decoration. The store flow captures the chat frame first and
    // reaches the terminal shot an unknown 15-30s later, while the replay
    // restarts on every terminal-bearing subscribe - so a capture that animates
    // is a capture whose screenshot depends on when the shutter happens to fall.
    //
    // The fixture answers that by holding still: the seed frame IS the settled
    // dialog and there is nothing after it that repaints. Assert exactly that,
    // because it is the property the store flow depends on. An earlier version
    // of this test compared "the frame by 6s" against "the final frame" without
    // noticing they are the same frame here, so it asserted one thing twice and
    // could not fail.
    expect(CLAUDE_CAPTURE_SHOTS.chunks.length).toBe(1);
    expect(CLAUDE_CAPTURE_SHOTS.chunks[0].offsetMs).toBe(0);

    // Every distinct row seen across the whole replay is a row of the seed
    // frame: nothing new is ever painted. Both directions, so a chunk that
    // added rows AND one that blanked them would both fail.
    const settledRows = shotsRows.filter((row) => row.trim().length > 0);
    expect([...shotsEveryRow].sort()).toEqual([...new Set(settledRows)].sort());

    // And the state it rests in is the dialog, which is what the chat lens
    // shows as a permission card at the same moment.
    expect(settledRows.join('\n')).toMatch(/Do you want to/);
  });
});

describe('every mode reports the grid it actually replays', () => {
  it('announces the capture own dimensions', () => {
    // The failure this guards is silent: announcing one grid while streaming
    // another renders every box border sliced mid-glyph, and it would show up
    // only in a published image. It is cheap now that there is a single
    // recording, and it was a live bug when there were two.
    expect(activeGrid()).toEqual({ cols: activeCapture().cols, rows: activeCapture().rows });
    expect(activeCapture()).toBe(CLAUDE_CAPTURE_SHOTS);
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
