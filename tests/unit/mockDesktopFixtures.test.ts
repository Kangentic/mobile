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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { beforeAll, describe, expect, it } from 'vitest';
import type { BoardTaskWire } from '@kangentic/protocol';

import { PR_READINESS_VERDICTS } from '@/components/board/prChipPresentation';
import {
  MOCK_CONTEXT_WINDOW_FOR_TEST,
  MOCK_CODEX_SESSION_DIFF,
  MOCK_CODEX_STATIC_SESSION,
  MOCK_EXTRA_THINKING_SESSIONS,
  MOCK_GEMINI_STATIC_SESSION,
  MOCK_OPENCODE_STATIC_SESSION,
  MOCK_QUEUED_STATIC_SESSION,
  MOCK_STATIC_SESSIONS,
  MOCK_STREAM_CEILING_FOR_TEST,
  activeCapture,
  activeGrid,
  archivedTasksFor,
  baseTranscriptForTest,
  codexTuiFrameForTest,
  diffFileContent,
  diffFileList,
  geminiTuiFrameForTest,
  initialTasks,
  initialTasks2,
  streamingUsedTokens,
} from '@/connection/mockDesktop';
import { CLAUDE_CAPTURE_SHOTS } from '@/devsupport/claudeCapture';
import { buildUnifiedDiffLines } from '@/diff/diffLines';
import { createLiveTailBuffer, stripAnsiPreservingLayout } from '@/terminal/liveTail';
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
  // Words that admit the fixture is a fixture. Not Kangentic domain nouns like
  // the rest, but the same failure: "Shipped: the completed mock task" sat on
  // the Done column for months because nothing collected that surface, and
  // since the reviewer/demo pairing shipped that column is one navigation from
  // where an App Store reviewer lands.
  //
  // Kept to these two. 'fixture', 'placeholder' and 'lorem' were tried and
  // reverted: the customer's own prose already says "benchmarking against the
  // 10k-row fixture", which is ordinary engineering English and exactly the
  // kind of true sentence a fictional customer should be able to write. A guard
  // that fires on real copy gets weakened or deleted, so it bans only the words
  // that can only ever mean "this content is not real".
  'mock',
  'demo',
];

/**
 * Prose-bearing keys, harvested recursively from a fixture value.
 *
 * A recursive walk rather than a hand-written traversal of the transcript union
 * because `TranscriptEntryWire` is a wide protocol type whose members carry
 * prose at different depths (assistant blocks, thinking blocks, tool results,
 * system notices), and an enumeration would silently stop covering a member the
 * day the package adds one. Restricted to prose KEYS rather than collecting
 * every string, because ids like `mock-session-1` are not rendered anywhere and
 * would make a ban on the word "mock" fire on scaffolding instead of on copy.
 */
const PROSE_KEYS = new Set(['text', 'title', 'description', 'content', 'note', 'summary', 'label', 'message']);

function collectProse(value: unknown, label: string, into: { label: string; text: string }[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectProse(item, label, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === 'string') {
      if (PROSE_KEYS.has(key)) into.push({ label: `${label}.${key}`, text: nested });
      continue;
    }
    collectProse(nested, `${label}.${key}`, into);
  }
}

/** Every string these fixtures put on screen. */
function renderedFixtureText(): { label: string; text: string }[] {
  const collected: { label: string; text: string }[] = [];
  // The whole chat lens. Previously uncollected, which meant every string in
  // the published 03-session-chat shelf was unguarded.
  collectProse(baseTranscriptForTest(), 'transcript', collected);
  // The Done columns and the completed-task screens behind them. Both real
  // project ids, because the two projects carry DISTINCT archived rows now -
  // the previous 'project-1' placeholder only ever exercised the default
  // branch.
  collectProse(archivedTasksFor('mock-project'), 'archived', collected);
  collectProse(archivedTasksFor('mock-project-relay'), 'archived relay', collected);
  for (const task of [...initialTasks(), ...initialTasks2()]) {
    collected.push({ label: `task ${task.id} title`, text: task.title });
    if (task.description) collected.push({ label: `task ${task.id} description`, text: task.description });
    if (task.branch_name) collected.push({ label: `task ${task.id} branch`, text: task.branch_name });
    for (const label of task.labels ?? []) collected.push({ label: `task ${task.id} label`, text: label });
  }
  for (const spec of MOCK_EXTRA_THINKING_SESSIONS) {
    collected.push({ label: `${spec.sessionId} title`, text: spec.title });
  }
  // Every static session's full surface: transcript seed, the canned chat
  // reply, and the terminal seed - all of which render since the demo pairing
  // made these screens reachable by App Review, and none of which the guard
  // collected while they were dev-only.
  for (const spec of MOCK_STATIC_SESSIONS) {
    collected.push({ label: `${spec.sessionId} user`, text: spec.userText });
    collected.push({ label: `${spec.sessionId} assistant`, text: spec.assistantText });
    collected.push({ label: `${spec.sessionId} reply`, text: spec.replyText });
    collected.push({ label: `${spec.sessionId} terminal seed`, text: spec.scrollback });
    if (spec.thinkingText) collected.push({ label: `${spec.sessionId} thinking`, text: spec.thinkingText });
    if (spec.closingText) collected.push({ label: `${spec.sessionId} closing`, text: spec.closingText });
    for (const toolCell of spec.toolCells ?? []) {
      // Inputs render on the tool card (a Write's content in full), results on
      // the result card - both are screen text, both get checked.
      collected.push({ label: `${spec.sessionId} tool input`, text: JSON.stringify(toolCell.input) });
      collected.push({ label: `${spec.sessionId} tool result`, text: toolCell.result });
    }
    // The later turns render the same four surfaces the opening one does.
    for (const [turnIndex, turn] of (spec.followUps ?? []).entries()) {
      const turnLabel = `${spec.sessionId} follow-up ${turnIndex + 2}`;
      collected.push({ label: `${turnLabel} user`, text: turn.userText });
      if (turn.thinkingText) collected.push({ label: `${turnLabel} thinking`, text: turn.thinkingText });
      if (turn.assistantText) collected.push({ label: `${turnLabel} assistant`, text: turn.assistantText });
      if (turn.closingText) collected.push({ label: `${turnLabel} closing`, text: turn.closingText });
      for (const toolCell of turn.toolCells ?? []) {
        collected.push({ label: `${turnLabel} tool input`, text: JSON.stringify(toolCell.input) });
        collected.push({ label: `${turnLabel} tool result`, text: toolCell.result });
      }
    }
    for (const file of spec.diff?.files ?? []) {
      collected.push({ label: `${spec.sessionId} diff path`, text: file.path });
    }
    for (const [diffPath, content] of Object.entries(spec.diff?.contents ?? {})) {
      collected.push({ label: `${spec.sessionId} diff ${diffPath}`, text: `${content.original}\n${content.modified}` });
    }
  }
  // The codex and gemini TUI frames are those sessions' live terminals.
  // Both alternating paints of each, since status lines differ.
  for (const paintTick of [0, 1]) {
    for (const row of codexTuiFrameForTest(paintTick).split('\r\n')) {
      collected.push({ label: `codex frame tick ${paintTick}`, text: row });
    }
    for (const row of geminiTuiFrameForTest(paintTick).split('\r\n')) {
      collected.push({ label: `gemini frame tick ${paintTick}`, text: row });
    }
  }
  // The codex session's Changes lens, which is not a static-session spec.
  for (const file of MOCK_CODEX_SESSION_DIFF.files) {
    collected.push({ label: 'codex diff path', text: file.path });
  }
  for (const [diffPath, content] of Object.entries(MOCK_CODEX_SESSION_DIFF.contents)) {
    collected.push({ label: `codex diff ${diffPath}`, text: `${content.original}\n${content.modified}` });
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
    // Each surface named individually, because "more than 30 strings" stayed
    // true the whole time the transcript and the Done column were collected by
    // nothing at all. A count cannot tell you WHICH screen went unguarded.
    expect(collected.some((entry) => entry.label.startsWith('transcript.'))).toBe(true);
    expect(collected.some((entry) => entry.label.startsWith('archived.'))).toBe(true);
    expect(collected.some((entry) => entry.text === 'Cache the product-grid query on the storefront home')).toBe(true);
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

/**
 * The mock board's PR-bearing cards are curated, per the comments beside them
 * in `initialTasks()`, to demonstrate the full set of readiness outcomes a
 * reviewer or a store screenshot can land on: every recognised verdict, a
 * value this client does not recognise (degrading to plain open), and a
 * stale verdict surviving on a PR that is no longer open. Nothing else in
 * the repo renders these fixtures through the board, so a retune that drops
 * one of those cases - the same way `pr_merge_readiness` itself could be
 * dropped in a merge - is invisible to every other check.
 *
 * Deliberately NOT pinned to which task id carries which verdict: these
 * cards get retuned for design review and the store shelves, so a copy of
 * today's assignment would just be a change-detector. What has to survive a
 * retune is the set of scenarios, so that is what is asserted, mirroring
 * `prChipPresentation.test.ts`'s own `PR_READINESS_VERDICTS` iteration - a
 * verdict added to that table fails HERE until the mock board actually shows
 * it, rather than waiting on a hand-updated list that would not know to
 * extend itself.
 */
describe('the mock board demonstrates every PR readiness verdict', () => {
  function prBearingTasks(): BoardTaskWire[] {
    return [...initialTasks(), ...initialTasks2()].filter((task) => task.pr_state !== null);
  }

  it('carries enough PR-bearing fixtures to demonstrate every scenario below', () => {
    // Not a non-vacuity guard - the `.some(...)` assertions below are already
    // false, not vacuously true, against an empty list. This is a real lower
    // bound: every recognised verdict needs its own open-PR card, plus one
    // unrecognised value and one stale verdict on a non-open PR, so the board
    // cannot satisfy every case below with fewer cards than that. Failing
    // here gives one readable message instead of the same shortfall reported
    // once per missing verdict.
    expect(prBearingTasks().length).toBeGreaterThanOrEqual(PR_READINESS_VERDICTS.length + 2);
  });

  it.each(PR_READINESS_VERDICTS)(
    'demonstrates the %s verdict on an open PR somewhere on the mock board',
    (verdict) => {
      const demonstrated = prBearingTasks().some(
        (task) => task.pr_state === 'open' && task.pr_merge_readiness === verdict,
      );
      expect(demonstrated).toBe(true);
    },
  );

  it('demonstrates a value this client does not recognise, so the bare-glyph degrade path is actually on screen', () => {
    const demonstrated = prBearingTasks().some(
      (task) =>
        task.pr_state === 'open' &&
        typeof task.pr_merge_readiness === 'string' &&
        !PR_READINESS_VERDICTS.includes(task.pr_merge_readiness),
    );
    expect(demonstrated).toBe(true);
  });

  it('demonstrates a stale verdict surviving on a non-open PR, so the open-only guard has something to prove', () => {
    // If the merged card's stale `ready` ever gets "tidied up" to null, the
    // board silently stops demonstrating that readiness is ignored outside
    // the open branch, and nothing else here would notice.
    const demonstrated = prBearingTasks().some(
      (task) =>
        task.pr_state !== 'open' &&
        typeof task.pr_merge_readiness === 'string' &&
        PR_READINESS_VERDICTS.includes(task.pr_merge_readiness),
    );
    expect(demonstrated).toBe(true);
  });
});

/**
 * scripts/buildTerminalFixture.mjs runs its OWN copy of this guard at
 * capture-build time (BANNED_TERMS), on the raw capture bytes rather than the
 * rendered fixture text this file checks. Its header says the two lists are
 * "kept in step" - but that was only ever a promise: nothing compared them,
 * and 'kangentic' itself was the one term that drifted, present in the
 * build-time list and missing from KANGENTIC_DOMAIN_TERMS above until it was
 * added a few lines up. Only re-adding it here closed THAT gap; nothing stops
 * the next one opening the same way, in either direction.
 *
 * This does not import buildTerminalFixture.mjs - its top level unconditionally
 * calls parseArgs (which exits the process without --capture) and, once past
 * that, writeFileSync, so importing it as a module is unsafe. Structural
 * source-text extraction instead, same approach as syncBranding.test.ts uses
 * for the same reason.
 */
describe('the two banned-vocabulary lists stay in step', () => {
  const buildScriptSource = readFileSync(
    join(__dirname, '..', '..', 'scripts', 'buildTerminalFixture.mjs'),
    'utf8',
  );

  function buildScriptBannedTerms(): string[] {
    const block = /const BANNED_TERMS = \[([^\]]*)\]/.exec(buildScriptSource);
    if (block === null) return [];
    return [...block[1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
  }

  it('finds a non-trivial BANNED_TERMS list at all', () => {
    // Non-vacuity guard: an empty extraction would make the equality check
    // below pass only when KANGENTIC_DOMAIN_TERMS is ALSO empty, which it
    // never is - but a regex that stopped matching for an unrelated reason
    // (the const renamed, the array reformatted) should fail loudly here
    // rather than silently validating nothing.
    expect(buildScriptBannedTerms().length).toBeGreaterThan(10);
  });

  it('bans exactly the same words the rendered-fixture check does', () => {
    // Set equality, both directions: a term added to one list and not the
    // other is exactly the drift that shipped 'kangentic' to a store listing
    // once already.
    expect([...buildScriptBannedTerms()].sort()).toEqual([...KANGENTIC_DOMAIN_TERMS].sort());
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
      [8, 2],
      [21, 2],
      [1, 1],
      [8, 1],
    ]);
  });

  it('totals its own per-file counts', () => {
    const files = diffFileList().files;
    const insertions = files.reduce((sum, file) => sum + file.insertions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    expect(insertions).toBe(diffFileList().totalInsertions);
    expect(deletions).toBe(diffFileList().totalDeletions);
  });

  it("lists the line counts the app itself derives from each file's before and after text", () => {
    // The list's numbers are a transcription of `git diff --numstat`, and diffFileContent is a
    // transcription of the same diff as whole files, which the app turns back into a unified diff
    // with buildUnifiedDiffLines (the Changes lens and the file-diff screen both do). A reviewer
    // reads the counts off one and the added and removed rows off the other, so they have to agree.
    const listed = diffFileList().files.map((file) => ({
      path: file.path,
      insertions: file.insertions,
      deletions: file.deletions,
    }));
    const derived = listed.map(({ path }) => {
      const { original, modified } = diffFileContent(path);
      const lines = buildUnifiedDiffLines(original, modified);
      return {
        path,
        insertions: lines.filter((line) => line.kind === 'add').length,
        deletions: lines.filter((line) => line.kind === 'remove').length,
      };
    });
    // Non-vacuity: a path diffFileContent does not know answers with two empty texts, which diffs
    // to nothing and would only agree with a list that claimed no change.
    expect(derived.every((file) => file.insertions + file.deletions > 0)).toBe(true);
    expect(derived).toEqual(listed);
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

  /**
   * The first call to `toolName` in the transcript with its result: the input it was made with and
   * the text it printed. Looked up by tool name and the id that pairs a result to its call, so a
   * renamed uuid does not blind the checks below.
   */
  function firstToolExchange(toolName: string): { input: Record<string, unknown>; content: string } | null {
    const transcript = baseTranscriptForTest();
    for (const entry of transcript) {
      if (entry.kind !== 'assistant') continue;
      for (const block of entry.blocks) {
        if (block.type !== 'tool_use' || block.name !== toolName || !isRecord(block.input)) continue;
        for (const candidate of transcript) {
          if (candidate.kind === 'tool_result' && candidate.toolUseId === block.id) {
            return { input: block.input, content: candidate.content };
          }
        }
      }
    }
    return null;
  }

  it('quotes call sites in the Grep result that the diff frame shows verbatim', () => {
    // The Grep result claims "checkout.tsx line 8 is `return loginRedirect();`", and the chat lens
    // renders it as tool output one swipe from the Changes lens. Where the file is one the diff
    // lists, line N of its ORIGINAL text has to be that line: a quote that disagrees reads as
    // output the agent made up. Hits in files the diff does not list are call sites the agent
    // left alone, so there is nothing to compare them with.
    const exchange = firstToolExchange('Grep');
    expect(exchange, 'the transcript has a Grep call with a result').not.toBeNull();
    const hits = (exchange?.content ?? '')
      .split('\n')
      .flatMap((line) => {
        const match = /^(.+?):(\d+):(.*)$/.exec(line);
        return match ? [{ path: match[1], lineNumber: Number(match[2]), text: match[3] }] : [];
      });
    const listedPaths = diffFileList().files.map((file) => file.path);
    const checkedHits = hits.filter((hit) => listedPaths.includes(hit.path));
    // Non-vacuity: the result carries hits, and at least one is in a listed file.
    expect(hits.length).toBeGreaterThan(0);
    expect(checkedHits.length).toBeGreaterThan(0);
    const mismatched = checkedHits.flatMap((hit) => {
      const originalLine = diffFileContent(hit.path).original.split('\n')[hit.lineNumber - 1];
      return originalLine === hit.text
        ? []
        : [`${hit.path}:${hit.lineNumber} quotes ${JSON.stringify(hit.text)} but the diff's original has ${JSON.stringify(originalLine)}`];
    });
    expect(mismatched).toEqual([]);
  });

  it("quotes the Read result's numbered lines exactly as the diff frame's original text has them", () => {
    // The same hazard through the other tool that prints file text: `cat -n` output, a right-aligned
    // line number, a tab, then the line. The Read here is of a file the diff lists.
    const exchange = firstToolExchange('Read');
    expect(exchange, 'the transcript has a Read call with a result').not.toBeNull();
    const filePath = exchange?.input.file_path;
    expect(typeof filePath).toBe('string');
    const wirePath = String(filePath).replace(WORKSPACE_ROOT, '').replace(/\\/g, '/');
    expect(diffFileList().files.map((file) => file.path)).toContain(wirePath);
    const originalLines = diffFileContent(wirePath).original.split('\n');
    const quotedLines = (exchange?.content ?? '').split('\n').map((line) => /^\s*(\d+)\t(.*)$/.exec(line));
    // Non-vacuity: every line of the result parsed as numbered text.
    expect(quotedLines.length).toBeGreaterThan(0);
    expect(quotedLines.every((match) => match !== null)).toBe(true);
    const mismatched = quotedLines.flatMap((match) => {
      if (match === null) return [];
      const lineNumber = Number(match[1]);
      const originalLine = originalLines[lineNumber - 1];
      return originalLine === match[2]
        ? []
        : [`${wirePath}:${lineNumber} quotes ${JSON.stringify(match[2])} but the diff's original has ${JSON.stringify(originalLine)}`];
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
    // dialog and NOTHING streams after it. It is seed-only by construction now,
    // not just by choice: the seed is widened to the announced grid, and any
    // chunk after it was recorded for the narrower one, so
    // scripts/buildTerminalFixture.mjs refuses one that paints. Assert the
    // property the store flow depends on directly. (An earlier version compared
    // "the frame by 6s" against "the final frame" without noticing they were the
    // same frame, so it asserted one thing twice and could not fail.)
    expect(CLAUDE_CAPTURE_SHOTS.chunks).toEqual([]);

    // And the state it rests in is the dialog, which is what the chat lens
    // shows as a permission card at the same moment.
    const settledRows = shotsRows.filter((row) => row.trim().length > 0);
    expect(settledRows.join('\n')).toMatch(/Do you want to/);
  });

  /**
   * The shape of the seed itself, the bytes a phone receives on subscribing. The settled-frame
   * checks above read it back through a terminal, which cannot see these: each is a property of
   * how the bytes are written, and each one wrong leaves a screen that still looks right.
   */
  describe('the seed frame carries what a real desktop seed carries', () => {
    /** Enter the alternate screen and home the cursor: what every alt-screen seed opens with. */
    const ALT_SCREEN_PREFIX = '\x1b[?1049h\x1b[H';
    const seedFrame = CLAUDE_CAPTURE_SHOTS.seedFrame;

    /** The modes a headless terminal reports after the seed is replayed at the grid the capture announces. */
    async function modesAfterReplaying(seed: string): Promise<Terminal['modes']> {
      const terminal = new Terminal({
        cols: CLAUDE_CAPTURE_SHOTS.cols,
        rows: CLAUDE_CAPTURE_SHOTS.rows,
        scrollback: 0,
        allowProposedApi: true,
      });
      await new Promise<void>((resolveFlush) => terminal.write(seed, resolveFlush));
      const modes = { ...terminal.modes };
      terminal.dispose();
      return modes;
    }

    it('opens on the alternate screen, as a session that is running a full-screen TUI does', () => {
      expect(seedFrame.startsWith(ALT_SCREEN_PREFIX)).toBe(true);
    });

    it('positions nothing absolutely after that, because the live-tail cleaner reads one as a repaint', () => {
      // src/terminal/liveTail.ts resets on ANY cursor position (CUP or HVP, with or without
      // parameters): it cannot represent a repaint as a tail. A seed that ends in one leaves the chat
      // lens with an empty live tail until the next byte arrives. The prefix's own home is before
      // any content, so it resets nothing worth keeping.
      const afterPrefix = seedFrame.slice(ALT_SCREEN_PREFIX.length);
      // Compared as the list of offending sequences, so a failure names them and does not print the frame.
      expect(afterPrefix.match(/\x1b\[[\d;]*[Hf]/g) ?? []).toEqual([]);
      // And the consumer itself: the seed's text is still there after the cleaner has read it.
      const liveTail = createLiveTailBuffer();
      liveTail.append(seedFrame);
      expect(liveTail.snapshotLines().join('\n')).toContain('Do you want to');
    });

    it("carries the recording's modes, because the phone scrolls by whichever mouse mode is on", async () => {
      // scripts/xterm-page/historyScroll.js takes mouse reporting as the authority on how a touch
      // drag scrolls (a wheel report when the app wants the mouse, page keys when it does not), so a
      // seed without ?1003h scrolls a Claude session differently from a real one.
      const recordedModes = ['\x1b[?2004h', '\x1b[?1004h', '\x1b[?1003h'];
      expect(recordedModes.filter((sequence) => !seedFrame.includes(sequence))).toEqual([]);
      const modes = await modesAfterReplaying(seedFrame);
      expect(modes.bracketedPasteMode).toBe(true);
      expect(modes.sendFocusMode).toBe(true);
      expect(modes.mouseTrackingMode).toBe('any');
    });

    it('leaves the cursor hidden, as Claude Code does while it is drawing', () => {
      const hides = seedFrame.lastIndexOf('\x1b[?25l');
      expect(hides).toBeGreaterThanOrEqual(0);
      // Nothing shows it again after the last hide.
      expect(seedFrame.slice(hides)).not.toContain('\x1b[?25h');
    });

    it('turns autowrap back on after the rows were written with it off', async () => {
      // The rows are written with autowrap off so a width the two sides disagree on overwrites the
      // last column instead of wrapping. Left off, every line the agent streams AFTER the seed would
      // overwrite the last column too, on a terminal that was never told to.
      const turnedOff = seedFrame.indexOf('\x1b[?7l');
      const turnedOn = seedFrame.indexOf('\x1b[?7h');
      expect(turnedOff).toBeGreaterThanOrEqual(0);
      expect(turnedOn).toBeGreaterThan(turnedOff);
      expect((await modesAfterReplaying(seedFrame)).wraparoundMode).toBe(true);
    });
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

describe('authored claude frames fill the grid with the live chrome', () => {
  // Transcribed from a real session's PTY ring (2026-08-27): the input area
  // is rules + ❯ + the amber 'auto mode on' footer, pinned to the bottom of
  // a frame that fills the grid. A bare 20-row scrollback floating in an
  // empty pane is exactly what read as fake next to the recorded session.
  it('pins the input area to the bottom of a full-height frame', () => {
    // Positively derived, not a substring scan of the very text being
    // verified below (that self-referential filter is what let a one-in-one
    // swap - one Claude session losing the chrome while some other session
    // gained a copy of the marker text - cancel out against a bare length
    // check). Exclude the three CLI-flavored static exports by identity, and
    // also anything sharing the codex fixture's model id: MOCK_STATIC_SESSIONS
    // additionally packs one Codex-flavored session INTO the extra-thinking
    // bucket ('mock-session-thinking-5', never exported under its own name),
    // so identity exclusion alone would miss it.
    const codexModelId = MOCK_CODEX_STATIC_SESSION.model.id;
    const framedSpecs = MOCK_STATIC_SESSIONS.filter(
      (spec) =>
        spec !== MOCK_CODEX_STATIC_SESSION &&
        spec !== MOCK_GEMINI_STATIC_SESSION &&
        spec !== MOCK_OPENCODE_STATIC_SESSION &&
        // Excluded for a different reason than the three above, which are
        // merely a different CLI's chrome: a QUEUED session has no PTY at all,
        // so there is no frame for the desktop to serialize and an empty
        // scrollback is the correct fixture. Asserted positively below rather
        // than left as a silent hole in this guard.
        spec !== MOCK_QUEUED_STATIC_SESSION &&
        spec.model.id !== codexModelId,
    );
    // The expectation side is a LITERAL set of ids, not the same predicate
    // recomputed - so reflavoring one of these sessions to Codex (or vice
    // versa) changes the selection side without moving the expectation,
    // and the mismatch fails loudly instead of both sides drifting together.
    // 'mock-session-thinking-5' is deliberately absent: it is Codex-flavored
    // (see above) so the filter above excludes it too.
    expect(framedSpecs.map((spec) => spec.sessionId).sort()).toEqual(
      [
        'mock-session-thinking-2',
        'mock-session-thinking-3',
        'mock-session-thinking-4',
        'mock-session-idle',
        'mock-session-paused',
        'mock-project-archived-session-1',
        'mock-project-relay-archived-session-1',
      ].sort(),
    );
    for (const spec of framedSpecs) {
      const rows = spec.scrollback.split('\r\n');
      expect(rows.length, `${spec.sessionId} fills the grid`).toBeGreaterThanOrEqual(activeGrid().rows);
      const bottomRows = rows.slice(-4).join('\n');
      expect(bottomRows, `${spec.sessionId} prompt`).toContain('❯');
      expect(bottomRows, `${spec.sessionId} footer`).toContain('auto mode on');
    }
  });

  /**
   * The other half of the exclusion above. Without this, giving the queued
   * session a scrollback would silently drop it out of the guard's reach and
   * nothing would notice - and a queued session that paints a terminal is not
   * a cosmetic slip: it would mean the rig had stopped modelling a placeholder
   * with `pty: null` and started implying the state through content, which is
   * exactly the failure MOCK_QUEUED_STATIC_SESSION's own comment warns against.
   */
  it('keeps the queued session frameless, because a placeholder has no PTY', () => {
    expect(MOCK_QUEUED_STATIC_SESSION.scrollback).toBe('');
    expect(MOCK_QUEUED_STATIC_SESSION.sessionStatus).toBe('queued');
  });
});

describe('the codex TUI frame stays inside the reported grid', () => {
  // Regression for b5fcd86: codexTuiFrame used to hard-code a 38-glyph border
  // while its two alternating status strings were 35 and 26 columns, so the
  // box was ragged on one paint and over-wide on both against a grid the
  // border never actually measured itself against. Nothing caught it because
  // the column checks only ever looked at the streaming session's fixture,
  // never the codex session's. Every row is padded to activeGrid().cols, not
  // a literal, so a future re-record at a different grid cannot leave this
  // fixture behind.
  const width = activeGrid().cols;

  function boxRows(paintTick: number): string[] {
    // Stripped per row (not whole-frame: the stripper also removes bare CR,
    // which would break the row split). The chrome carries SGR color now,
    // and the column budget is about VISIBLE glyphs.
    return codexTuiFrameForTest(paintTick)
      .split('\r\n')
      .map((row) => stripAnsiPreservingLayout(row))
      .filter((row) => row.length > 0);
  }

  it.each([0, 1])('pads the box border to exactly the grid width on paint tick %i', (paintTick) => {
    const rows = boxRows(paintTick);
    const topBorder = rows.find((row) => row.startsWith('╭'));
    const bottomBorder = rows.find((row) => row.startsWith('╰'));
    const statusRow = rows.find((row) => row.startsWith('│'));
    expect(topBorder).toBeDefined();
    expect(bottomBorder).toBeDefined();
    expect(statusRow).toBeDefined();
    expect([...(topBorder ?? '')].length).toBe(width);
    expect([...(bottomBorder ?? '')].length).toBe(width);
    expect([...(statusRow ?? '')].length).toBe(width);
  });

  it('keeps both alternating status strings inside the same border width', () => {
    // The two ticks alternate BETWEEN two different status strings
    // ('Refactoring src/http/retryPolicy.ts' vs 'Running the affected tests').
    // A fix that only pads one of them would still show ragged on the other.
    const evenBorderWidth = [...(boxRows(0).find((row) => row.startsWith('│')) ?? '')].length;
    const oddBorderWidth = [...(boxRows(1).find((row) => row.startsWith('│')) ?? '')].length;
    expect(evenBorderWidth).toBe(width);
    expect(oddBorderWidth).toBe(width);
  });
});

/**
 * Regression for b4c89f0 ("TWO PLAYBACK LEAKS"): the recorded-terminal replay
 * used to outlive both the /end-session and /respawn magic commands. The
 * respawn case is the worse one - activeSessionId is NOT null there, so a
 * playback left running would emit the dead session's recorded bytes into the
 * SUCCESSOR's terminal.
 *
 * There is no exported seam onto createMockDesktop()'s internal
 * terminalPlayback state (driving it for real needs a full loopback KK
 * handshake, which nothing in this repo does yet for this module - see the
 * fixture-content-only tests elsewhere in this file), so this checks the
 * WIRING structurally instead: both lifecycle functions must call
 * stopTerminalPlayback(). Cheap insurance against reintroduction, same
 * technique tests/unit/xtermPageScripts.test.ts uses to pin refit()'s body.
 */
describe('ending or respawning the streaming session stops its terminal replay', () => {
  const mockDesktopSource = readFileSync(join(__dirname, '..', '..', 'src', 'connection', 'mockDesktop.ts'), 'utf8');

  function functionBody(startMarker: string, endMarker: string): string {
    const start = mockDesktopSource.indexOf(startMarker);
    const end = mockDesktopSource.indexOf(endMarker, start);
    expect(start, `could not find "${startMarker}"`).toBeGreaterThanOrEqual(0);
    expect(end, `could not find "${endMarker}" after "${startMarker}"`).toBeGreaterThan(start);
    return mockDesktopSource.slice(start, end);
  }

  it('stops the replay in endActiveSession (the /end-session command)', () => {
    const body = functionBody('function endActiveSession(): void {', 'function respawnActiveSession(');
    expect(body).toContain('stopTerminalPlayback();');
  });

  it('stops the replay in respawnActiveSession (the /respawn and /respawn-quiet commands)', () => {
    // The marker stops at the opening parenthesis: the signature took a
    // nullable label with the quiet respawn, and a marker that spells the
    // parameter list breaks on the next one too.
    const body = functionBody('function respawnActiveSession(', 'function raiseQuestionPrompt(');
    expect(body).toContain('stopTerminalPlayback();');
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
