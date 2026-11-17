/**
 * Pins the contracts between the board's On agent turn end rows in kangentic.json and the script,
 * skills and messages that print the lines those rows read.
 *
 * A Text match row on the agent's line (`condition.text`) moves a card only when the WHOLE last
 * line of the agent's final message matches it. A row on the owner's message
 * (`condition.text.from: "user"`, Kangentic #1078) reads the owner's last message in the turn
 * instead. When a row and the line its producer prints drift apart (a reworded skill, a renamed
 * row, the verdict printed above its steps again), nothing errors anywhere: the card just waits in
 * its column. This is the mechanical half of CLAUDE.md's "change the row and the skill together":
 *
 * 1. Design: the Design contract asks for exactly the Shelved line, and Shelved is the column's
 *    only Move to column row on the agent's line. On to Planning reads the owner's message, so
 *    Design is a person's gate: the owner's "signed off" or drag moves the card on, never the
 *    agent. Its patterns are held to real sign-offs and real non-sign-offs, and to the board's own
 *    messages, which say "signed off" and must never move the card themselves.
 * 2. Code Review: the verdict script's closing block, and the summary the skill pastes verbatim,
 *    END on exactly the Back for revisions and On to Testing lines, for both verdicts. Exact
 *    equality is stricter than the desktop matcher (which ignores case and punctuation) on
 *    purpose: the script is deterministic, so the matcher's leniency is never what makes this pass.
 *    A pass with nothing to review (`--no-changes`) ends on Back for revisions too. A pass with a
 *    step only a person can do ends on `Needs owner:` below the verdict instead, and that line must
 *    match NEITHER row. A miss is the lenient direction, so it is checked through the same
 *    matcher the desktop runs, not exact inequality.
 * 3. Back for revisions carries the review's reply, which is where its numbered steps are.
 * 4. Testing: /pull-request prints the On to Merge line and names the row that reads it.
 * 5. Executing: the Apply findings message asks for exactly the lines its two move rows match.
 *    Design review sends the card BACK to Design, so the agent can ask for the owner's sign-off
 *    but never give it, and Executing has no row on the owner's message, which would make it a
 *    person's gate for every workflow.
 * 6. Merge: /merge-pull-request prints the Finish line and names the row that reads it.
 * 7. Every row is well formed: no legacy `finalLine` key, a Text match only on a turn-end row, no
 *    agent line that matches another row in its column, and every Move to column target is a
 *    column that exists.
 * 8. Every Text match row's routing (source, type, target column, run cap) is pinned in one table,
 *    and the table must list exactly the rows that carry a Text match, so a new or removed row
 *    fails by name.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderClosingBlock, renderNoChanges, renderSummary } from '../../scripts/review-verdict.mjs';

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');

type TextMatchSource = 'agent' | 'user';
type TextMatchPatterns = string | string[];

interface AutomationRow {
  name: string;
  type: string;
  /** The key older board files wrote. The desktop migrates it away, and this file must not carry it. */
  finalLine?: string;
  /** A Text match in short form (the agent's line), its long form naming whose message it reads, or an Agent evaluation. */
  condition?: { text?: TextMatchPatterns | { from: TextMatchSource; patterns: TextMatchPatterns }; agent?: string };
  maxRuns?: number;
  targetColumn?: string;
  message?: string;
}

interface BoardColumn {
  id: string;
  name: string;
  automations?: Record<string, AutomationRow[]>;
}

interface BoardConfig {
  columns: BoardColumn[];
}

function readRepositoryFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPOSITORY_ROOT, relativePath), 'utf8');
}

const board = JSON.parse(readRepositoryFile('kangentic.json')) as BoardConfig;

function columnNamed(columnName: string): BoardColumn {
  const column = board.columns.find((candidate) => candidate.name === columnName);
  if (!column) throw new Error(`kangentic.json has no "${columnName}" column`);
  return column;
}

function columnPosition(columnName: string): number {
  return board.columns.indexOf(columnNamed(columnName));
}

function automationRows(columnName: string, trigger: string): AutomationRow[] {
  return columnNamed(columnName).automations?.[trigger] ?? [];
}

function automationRow(columnName: string, trigger: string, rowName: string): AutomationRow {
  const row = automationRows(columnName, trigger).find((candidate) => candidate.name === rowName);
  if (!row) throw new Error(`kangentic.json's ${columnName} column has no "${rowName}" ${trigger} row`);
  return row;
}

function turnEndRows(columnName: string): AutomationRow[] {
  return automationRows(columnName, 'onTurnEnd');
}

function turnEndRow(columnName: string, rowName: string): AutomationRow {
  return automationRow(columnName, 'onTurnEnd', rowName);
}

/** A row's Text match as its list of patterns, or undefined when it has none. */
function textMatchPatternsOf(row: AutomationRow): string[] | undefined {
  const text = row.condition?.text;
  if (text === undefined) return undefined;
  const patterns = typeof text === 'object' && !Array.isArray(text) ? text.patterns : text;
  return Array.isArray(patterns) ? patterns : [patterns];
}

/** Whose message a row's Text match reads: the long form's `from`, else the agent's line. */
function textMatchSourceOf(row: AutomationRow): TextMatchSource {
  const text = row.condition?.text;
  return typeof text === 'object' && !Array.isArray(text) ? text.from : 'agent';
}

/** The one line a contract row's agent has to end on. */
function finalLineOf(columnName: string, rowName: string): string {
  const row = turnEndRow(columnName, rowName);
  const patterns = textMatchPatternsOf(row);
  if (patterns === undefined) throw new Error(`the ${columnName} "${rowName}" row has no Text match`);
  if (textMatchSourceOf(row) !== 'agent') throw new Error(`the ${columnName} "${rowName}" row reads the owner's message, not a line the agent ends on`);
  if (patterns.length !== 1) throw new Error(`the ${columnName} "${rowName}" row has several patterns; a contract pins one line`);
  return patterns[0];
}

/*
 * The desktop's Text match, ported from Kangentic's `src/shared/final-line-match.ts` (#1078) so a
 * row's patterns are checked the way the app checks them: case, punctuation, symbols, markdown
 * and invisible characters are forgiven, `*` matches any text and the pattern must cover all of
 * it, and a pattern that starts with `!` rules the text out. Keep it in step with that file.
 */
const MATCH_SEPARATORS = /[\s\p{P}\p{S}\p{C}\p{Me}\p{Variation_Selector}]+/gu;

function spacedForMatch(text: string): string {
  return text.toLowerCase().replace(MATCH_SEPARATORS, ' ');
}

function normalizeForMatch(text: string): string {
  return spacedForMatch(text).trim();
}

function normalizedTextMatchesPattern(pattern: string, normalizedText: string): boolean {
  const parts = pattern.split('*').map(spacedForMatch);
  parts[0] = parts[0].trimStart();
  parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
  if (parts.length === 1) return normalizedText === parts[0];
  const head = parts[0];
  const tail = parts[parts.length - 1];
  const end = normalizedText.length - tail.length;
  if (end < head.length || !normalizedText.startsWith(head) || !normalizedText.endsWith(tail)) return false;
  let cursor = head.length;
  for (const middle of parts.slice(1, -1)) {
    const foundAt = normalizedText.indexOf(middle, cursor);
    if (foundAt === -1 || foundAt + middle.length > end) return false;
    cursor = foundAt + middle.length;
  }
  return true;
}

/** Whether any text could match one pattern: it has a wildcard, or a word once normalized. */
function patternCanMatch(pattern: string): boolean {
  return pattern.includes('*') || normalizeForMatch(pattern) !== '';
}

/** Whether text meets a Text match: any plain pattern (or none) and no `!` pattern. */
function textMatchMatches(patterns: readonly string[], text: string): boolean {
  const plain = patterns.filter((pattern) => !pattern.startsWith('!'));
  const negated = patterns.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.replace(/^!\s*/, ''));
  const normalizedText = normalizeForMatch(text);
  const included = plain.length > 0
    ? plain.some((pattern) => normalizedTextMatchesPattern(pattern, normalizedText))
    : negated.some(patternCanMatch);
  return included && !negated.some((pattern) => normalizedTextMatchesPattern(pattern, normalizedText));
}

/** The last line of a reply with a word in it, as the app reads an agent's final line. */
function finalMatchLine(reply: string): string | null {
  const lines = reply.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (normalizeForMatch(lines[index]) !== '') return lines[index].trim();
  }
  return null;
}

/** Whether a row moves the card for this reply (an agent-line row) or this message (an owner's row). */
function rowMatches(row: AutomationRow, replyOrMessage: string): boolean {
  const patterns = textMatchPatternsOf(row);
  if (patterns === undefined) throw new Error(`the "${row.name}" row has no Text match`);
  // The owner's message fails closed when it has no words, as the app's read of it does.
  if (textMatchSourceOf(row) === 'user') return normalizeForMatch(replyOrMessage) !== '' && textMatchMatches(patterns, replyOrMessage);
  const line = finalMatchLine(replyOrMessage);
  return line !== null && textMatchMatches(patterns, line);
}

// A boolean with a message, so a failure names the missing text instead of printing a whole skill.
function expectTextIn(source: string, sourceName: string, expectedText: string): void {
  expect(source.includes(expectedText), `${sourceName} does not contain ${expectedText}`).toBe(true);
}

function escapeRegularExpression(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The skill must INSTRUCT the agent to end the message, alone, on the line. A bare mention of the
// backticked line (a summary, a cross-reference) does not count, and neither does the failure
// path's "last line of that message" for a different line. `[^`]*` crosses a line break.
function expectLastLineInstruction(skill: string, skillPath: string, finalLine: string): void {
  const instruction = new RegExp(
    `last line of the message, alone[^\`]*\`${escapeRegularExpression(finalLine)}\``,
    'i',
  );
  expect(
    instruction.test(skill),
    `${skillPath} does not tell the agent the last line of the message, alone, is \`${finalLine}\``,
  ).toBe(true);
}

function lastLineOf(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines[lines.length - 1];
}

const READY_REPORT = { checks: { typecheck: 'pass', scopedTests: 'none' }, findings: [] };

const BLOCKED_REPORT = {
  checks: { typecheck: 'fail', scopedTests: 'pass' },
  findings: [
    {
      id: 1,
      severity: 'high',
      category: 'Correctness',
      location: 'src/channel/subscriptionManager.ts:30',
      file: 'src/channel/subscriptionManager.ts',
      mechanism: 'cold-start fan-out ignores the concurrency bound',
      status: 'blocked',
      reason: 'outside the diff and spans every subscribe caller',
      step: 'route the screen-driven re-subscribes through the bounded queue in this task',
    },
  ],
};

const OWNER_STEP = 'run the NSE probe on a physical iPhone and report what it shows';

const NEEDS_OWNER_REPORT = {
  checks: { typecheck: 'pass', scopedTests: 'pass' },
  findings: [
    {
      id: 1,
      severity: 'medium',
      category: 'Coverage',
      location: 'targets/nse/NotificationPruning.swift:40',
      file: 'targets/nse/NotificationPruning.swift',
      mechanism: 'pruning unproven on hardware',
      status: 'blocked',
      reason: 'a simulator cannot run the extension, and this machine has no iPhone',
      step: OWNER_STEP,
      needsOwner: true,
    },
  ],
};

const SIGN_OFF_HINT = 'To sign off, type signed off or move the card to Planning.';

describe('board turn-end contracts: Design', () => {
  const designContract = (): string => automationRow('Design', 'onEnter', 'Design contract').message ?? '';

  // The agent can only end on a line it was told about, and nothing else prints this one.
  it('has the Design contract ask for exactly the Shelved line', () => {
    expectTextIn(designContract(), 'the Design contract', `"${finalLineOf('Design', 'Shelved')}"`);
  });

  // Its only Move to column row on the agent's line sends the card back, which is what makes
  // Design a person's gate: no line the agent writes moves a card on out of it.
  it('sends a shelved design back to To Do, and moves a card forward on no agent line', () => {
    expect(turnEndRow('Design', 'Shelved').targetColumn).toBe('To Do');
    const agentLineMoveRows = turnEndRows('Design')
      .filter((row) => row.type === 'move_to_column' && textMatchSourceOf(row) === 'agent');
    expect(agentLineMoveRows.map((row) => row.name)).toEqual(['Shelved']);
  });

  // The owner's sign-off is the way on (#1078): their message, never the agent's.
  it('moves the card to Planning on the owner\'s sign-off message', () => {
    const onToPlanning = turnEndRow('Design', 'On to Planning');
    expect(onToPlanning.type).toBe('move_to_column');
    expect(textMatchSourceOf(onToPlanning)).toBe('user');
    expect(onToPlanning.targetColumn).toBe('Planning');
  });

  // Frequency counts across the board's own moves and starts over only on a person's move. A card
  // designed first and then sent back by Executing's Design review visits Design twice, so the
  // desktop's "at most once" would leave the second "signed off" moving nothing.
  it('leaves On to Planning uncapped, so a card Executing sends back can be signed off again', () => {
    expect(turnEndRow('Design', 'On to Planning').maxRuns).toBeUndefined();
  });

  it('reads a plain sign-off as one, and the owner\'s other replies as not', () => {
    const onToPlanning = turnEndRow('Design', 'On to Planning');
    const signOffs = ['signed off', 'Signed off.', '**Design approved**', 'The design is approved', 'agreed, design is signed off with recommendations'];
    for (const message of signOffs) {
      expect(rowMatches(onToPlanning, message), `"${message}" must move the card`).toBe(true);
    }
    // Real owner messages from desktop Design cards that were NOT the sign-off (#1078), plus the
    // refusals and partial sign-offs its `!` patterns rule out.
    const notSignOffs = [
      'overall looks great, last part to settle here',
      'proceed... then once all settled we can move this task to planning',
      'rest look good',
      '4-5 sounds good as recommended by you',
      'approved',
      'This is not signed off yet',
      'The design is not approved',
      'all recommendations are signed off except the header button',
      // Refusals whose negation does not sit right against "signed off".
      'this isn\'t signed off yet',
      'not yet signed off, the header still needs work',
      'it isn\'t yet signed off',
      'this hasn\'t been signed off',
      'it has not been signed off',
    ];
    for (const message of notSignOffs) {
      expect(rowMatches(onToPlanning, message), `"${message}" must not move the card`).toBe(false);
    }
  });

  // The board's own messages say "signed off". Kangentic drops a message it typed itself, and these
  // are the backstop for a record it missed: none of them may read as the owner's sign-off.
  it('never reads the board\'s own messages as the owner\'s sign-off', () => {
    const onToPlanning = turnEndRow('Design', 'On to Planning');
    const boardMessages = [
      { name: 'the Design contract', text: designContract() },
      { name: 'the sign-off hint line', text: SIGN_OFF_HINT },
      { name: 'the Apply findings message', text: turnEndRow('Executing', 'Apply findings').message ?? '' },
      { name: 'the Signed off exit message', text: automationRow('Design', 'onExit', 'Signed off').message ?? '' },
    ];
    for (const { name, text } of boardMessages) {
      expect(text, name).not.toBe('');
      expect(rowMatches(onToPlanning, text), `${name} moves the card to Planning`).toBe(false);
    }
  });

  // The contract tells the owner how to sign off and the agent what to do when they have.
  it('has the Design contract name the sign-off and leave the move to the board', () => {
    const contract = designContract();
    expectTextIn(contract, 'the Design contract', SIGN_OFF_HINT);
    expectTextIn(contract, 'the Design contract', 'The board moves the card.');
    expectTextIn(contract, 'the Design contract', 'Never move this card yourself.');
  });

  // Design review sends cards with built work here, and To Do removes the worktree.
  it('has the Design contract keep built work out of a silent shelve', () => {
    const contract = designContract();
    expectTextIn(contract, 'the Design contract', 'sent back from Executing');
    expectTextIn(contract, 'the Design contract', 'shelve only once the owner confirms');
  });

  // The agent's own sign-off hint line must not read as Shelved.
  it('keeps the sign-off hint line from reading as shelved', () => {
    expect(rowMatches(turnEndRow('Design', 'Shelved'), SIGN_OFF_HINT)).toBe(false);
  });

  // The exit row fires on every move out, and a drag straight to Executing must not enter plan mode.
  it('names the destination in the sign-off message', () => {
    expect(automationRow('Design', 'onExit', 'Signed off').message).toContain('{{toColumn}}');
  });

  // A shelve to To Do exits Design too, so the exit message must not claim a sign-off on its own,
  // and it has to tell an agent in any other column that there is nothing to do.
  it('keeps the exit message true for a shelve as well as a sign-off', () => {
    const exitMessage = automationRow('Design', 'onExit', 'Signed off').message ?? '';
    expect(exitMessage.startsWith('The design is signed off'), 'the exit message claims a sign-off on every exit').toBe(false);
    expectTextIn(exitMessage, 'the Signed off exit message', 'In any other column');
  });
});

describe('board turn-end contracts: Code Review', () => {
  it('ends a Ready pass on exactly the On to Testing line', () => {
    const onToTesting = finalLineOf('Code Review', 'On to Testing');
    expect(lastLineOf(renderClosingBlock(READY_REPORT))).toBe(onToTesting);
    expect(lastLineOf(renderSummary(READY_REPORT))).toBe(onToTesting);
  });

  it('ends a Blocked pass on exactly the Back for revisions line, below its numbered steps', () => {
    const backForRevisions = finalLineOf('Code Review', 'Back for revisions');
    const closingLines = renderClosingBlock(BLOCKED_REPORT).split('\n');
    expect(closingLines[closingLines.length - 1]).toBe(backForRevisions);
    expect(closingLines.slice(0, -1).every((line) => /^\d+\. /.test(line))).toBe(true);
    expect(closingLines.length).toBeGreaterThan(1);
    expect(lastLineOf(renderSummary(BLOCKED_REPORT))).toBe(backForRevisions);
  });

  it('sends a pass with nothing to review back to Executing, on exactly the Back for revisions line', () => {
    const backForRevisions = finalLineOf('Code Review', 'Back for revisions');
    expect(lastLineOf(renderNoChanges('main'))).toBe(backForRevisions);
    expect(lastLineOf(renderNoChanges(''))).toBe(backForRevisions);
  });

  it('leaves a pass with a step only a person can do where it is: a Needs owner line no row matches', () => {
    const rows = [turnEndRow('Code Review', 'Back for revisions'), turnEndRow('Code Review', 'On to Testing')];
    for (const message of [renderClosingBlock(NEEDS_OWNER_REPORT), renderSummary(NEEDS_OWNER_REPORT)]) {
      const lines = message.trimEnd().split('\n');
      expect(lines[lines.length - 1]).toBe(`Needs owner: ${OWNER_STEP}`);
      expect(lines[lines.length - 2], 'the verdict sits directly above it').toBe('Verdict: Blocked');
      for (const row of rows) {
        expect(rowMatches(row, message), `the message moves the card on "${row.name}"`).toBe(false);
      }
    }
  });

  it('sends the review reply back to Executing, since the steps live in it', () => {
    const backForRevisions = turnEndRow('Code Review', 'Back for revisions');
    expect(backForRevisions.targetColumn).toBe('Executing');
    expect(backForRevisions.message).toContain('{{agentReply}}');
  });
});

describe('board turn-end contracts: Testing', () => {
  it('has /pull-request print the On to Merge line and name the row that reads it', () => {
    const onToMerge = finalLineOf('Testing', 'On to Merge');
    const skillPath = '.claude/skills/pull-request/SKILL.md';
    const pullRequestSkill = readRepositoryFile(skillPath);
    expectLastLineInstruction(pullRequestSkill, skillPath, onToMerge);
    expectTextIn(pullRequestSkill, skillPath, '"On to Merge"');
  });
});

describe('board turn-end contracts: Executing', () => {
  const applyFindingsMessage = (): string => turnEndRow('Executing', 'Apply findings').message ?? '';

  it('asks the agent for exactly the lines the Executing rows match', () => {
    const sourceName = 'the Apply findings message';
    expectTextIn(applyFindingsMessage(), sourceName, `"${finalLineOf('Executing', 'On to Code Review')}"`);
    expectTextIn(applyFindingsMessage(), sourceName, `"${finalLineOf('Executing', 'Design review')}"`);
    expectTextIn(applyFindingsMessage(), sourceName, 'final line, alone');
  });

  // An agent told only "not as follow-up tasks" took on the four tasks it had just filed, then
  // deleted them (desktop board). An unfiled finding still ships in the task.
  it('keeps the findings pass off work already filed as a task', () => {
    expectTextIn(applyFindingsMessage(), 'the Apply findings message', 'not as follow-up tasks');
    expectTextIn(applyFindingsMessage(), 'the Apply findings message', 'Skip anything already filed as a task on the board, and never delete or move one.');
  });

  // The design line is the agent asking for the owner's look, never giving the sign-off itself
  // (desktop #1032: an agent that could move a card on its own design line signed it off).
  it('sends the card back to Design on the design line, where only the owner moves it on', () => {
    const designReview = turnEndRow('Executing', 'Design review');
    expect(designReview.type).toBe('move_to_column');
    expect(designReview.targetColumn).toBe('Design');
    expect(columnPosition('Design'), 'Design must sit before Executing, so the move is a send-back').toBeLessThan(columnPosition('Executing'));
  });

  // A forward row on the owner's message makes its column a person's gate for a workflow
  // (`isSendBackOnly` in the desktop's workflow-step-condition.ts): every workflow step in
  // Executing would stop for a person, and the planner would say only a person moves a card out.
  it('has no row on the owner\'s message, so Executing never becomes a person\'s gate', () => {
    expect(turnEndRows('Executing').filter((row) => textMatchSourceOf(row) === 'user').map((row) => row.name)).toEqual([]);
    const forwardAgentRows = turnEndRows('Executing').filter((row) =>
      row.type === 'move_to_column' && row.targetColumn !== undefined && columnPosition(row.targetColumn) > columnPosition('Executing'));
    expect(forwardAgentRows.map((row) => row.name)).toEqual(['On to Code Review']);
  });

  // A Move to column row that runs ends the turn-end list, so both lines the message asks for are
  // moves above it and the message needs no Condition to skip them. A notify-only design row here
  // would let Apply findings fire on the design line and queue behind the owner's review.
  it('ends on Apply findings, a catch-all below both move rows, with no Condition', () => {
    const rows = turnEndRows('Executing');
    const applyFindings = turnEndRow('Executing', 'Apply findings');
    expect(applyFindings.type).toBe('send_message');
    expect(applyFindings.condition).toBeUndefined();
    expect(rows[rows.length - 1].name).toBe('Apply findings');
    for (const moveRowName of ['On to Code Review', 'Design review']) {
      expect(turnEndRow('Executing', moveRowName).type, moveRowName).toBe('move_to_column');
    }
  });
});

describe('board turn-end contracts: /upgrade-deps', () => {
  // A task run of /upgrade-deps ends in Executing, so apply.md's Finish section is a producer of
  // both Executing lines. Read from Finish only: the mid-run section names the same lines to say
  // when NOT to write them, which would satisfy a whole-file check with Finish reworded.
  it('has apply.md end a task run on exactly the lines the Executing rows match', () => {
    const skillPath = '.claude/skills/upgrade-deps/apply.md';
    const applyGuide = readRepositoryFile(skillPath);
    const finishIndex = applyGuide.indexOf('## Finish');
    expect(finishIndex, `${skillPath} lost its Finish section`).toBeGreaterThan(-1);
    const finish = applyGuide.slice(finishIndex);
    expectTextIn(finish, `${skillPath} Finish`, 'last line of the message, alone');
    expectTextIn(finish, `${skillPath} Finish`, `\`${finalLineOf('Executing', 'On to Code Review')}\``);
    expectTextIn(finish, `${skillPath} Finish`, `\`${finalLineOf('Executing', 'Design review')}\``);
  });
});

describe('board turn-end contracts: Merge', () => {
  it('has /merge-pull-request print the Finish line and name the row that reads it', () => {
    const finish = finalLineOf('Merge', 'Finish');
    const skillPath = '.claude/skills/merge-pull-request/SKILL.md';
    const mergePullRequestSkill = readRepositoryFile(skillPath);
    expectLastLineInstruction(mergePullRequestSkill, skillPath, finish);
    expectTextIn(mergePullRequestSkill, skillPath, '"Finish"');
  });
});

interface TextMatchRoute {
  columnName: string;
  rowName: string;
  source: TextMatchSource;
  type: string;
  targetColumn?: string;
  maxRuns?: number;
}

// Every row with a Text match and where it sends the card. An absent field here must be absent in
// kangentic.json too. The test below keeps this list and the board the same set of rows.
const TEXT_MATCH_ROUTES: readonly TextMatchRoute[] = [
  { columnName: 'Design', rowName: 'Shelved', source: 'agent', type: 'move_to_column', targetColumn: 'To Do' },
  { columnName: 'Design', rowName: 'On to Planning', source: 'user', type: 'move_to_column', targetColumn: 'Planning' },
  { columnName: 'Executing', rowName: 'On to Code Review', source: 'agent', type: 'move_to_column', targetColumn: 'Code Review', maxRuns: 4 },
  { columnName: 'Executing', rowName: 'Design review', source: 'agent', type: 'move_to_column', targetColumn: 'Design' },
  { columnName: 'Code Review', rowName: 'Back for revisions', source: 'agent', type: 'move_to_column', targetColumn: 'Executing', maxRuns: 3 },
  { columnName: 'Code Review', rowName: 'On to Testing', source: 'agent', type: 'move_to_column', targetColumn: 'Testing', maxRuns: 1 },
  { columnName: 'Testing', rowName: 'On to Merge', source: 'agent', type: 'move_to_column', targetColumn: 'Merge', maxRuns: 1 },
  { columnName: 'Merge', rowName: 'Finish', source: 'agent', type: 'move_to_column', targetColumn: 'Done', maxRuns: 1 },
];

describe('board turn-end contracts: row shape', () => {
  const columnNames = new Set(board.columns.map((column) => column.name));
  const everyRow = board.columns.flatMap((column) =>
    Object.entries(column.automations ?? {}).flatMap(([trigger, rows]) =>
      rows.map((row) => ({ columnName: column.name, trigger, row })),
    ),
  );
  const textMatchRows = everyRow.filter(({ row }) => textMatchPatternsOf(row) !== undefined);

  // The desktop converts a legacy finalLine on open and writes condition.text (#1078). A finalLine
  // committed here would be rewritten by the first open, a diff in a tracked file nobody made.
  it('writes no legacy finalLine key', () => {
    expect(everyRow.filter(({ row }) => row.finalLine !== undefined).map(({ columnName, row }) => `${columnName} / ${row.name}`)).toEqual([]);
  });

  // The listed set is never empty, so an emptied board cannot pass this vacuously.
  it('has a Text match on exactly the rows TEXT_MATCH_ROUTES pins, no more and no fewer', () => {
    expect(TEXT_MATCH_ROUTES.length).toBeGreaterThan(0);
    const rowKey = (columnName: string, rowName: string): string => `${columnName} / ${rowName}`;
    const boardKeys = textMatchRows.map(({ columnName, row }) => rowKey(columnName, row.name)).sort();
    const pinnedKeys = TEXT_MATCH_ROUTES.map(({ columnName, rowName }) => rowKey(columnName, rowName)).sort();
    expect(boardKeys).toEqual(pinnedKeys);
  });

  it.each(TEXT_MATCH_ROUTES)('routes $columnName "$rowName" as pinned', (route) => {
    const row = turnEndRow(route.columnName, route.rowName);
    const label = `${route.columnName} "${route.rowName}"`;
    expect(textMatchSourceOf(row), label).toBe(route.source);
    expect(row.type, label).toBe(route.type);
    // toBe(undefined) is toBeUndefined: a pinned-absent field must be absent on the row.
    expect(row.targetColumn, label).toBe(route.targetColumn);
    expect(row.maxRuns, label).toBe(route.maxRuns);
  });

  it('puts a Text match only on a turn-end row, never beside an Agent evaluation', () => {
    for (const { columnName, trigger, row } of textMatchRows) {
      expect(trigger, `${columnName} "${row.name}"`).toBe('onTurnEnd');
      expect(row.condition?.agent, `${columnName} "${row.name}"`).toBeUndefined();
    }
  });

  it('never lets one row\'s agent line match another Text match row in its column', () => {
    const agentLineRows = textMatchRows.filter(({ row }) => textMatchSourceOf(row) === 'agent');
    for (const { columnName, row } of agentLineRows) {
      const line = finalLineOf(columnName, row.name);
      for (const { columnName: otherColumn, row: otherRow } of agentLineRows) {
        if (otherColumn !== columnName || otherRow === row) continue;
        expect(rowMatches(otherRow, line), `${columnName}: "${line}" matches "${otherRow.name}"`).toBe(false);
      }
    }
  });

  it('moves only to a column the board has', () => {
    for (const { columnName, row } of everyRow) {
      if (row.type !== 'move_to_column') continue;
      expect(columnNames.has(row.targetColumn ?? ''), `${columnName} "${row.name}" -> ${row.targetColumn}`).toBe(true);
    }
  });
});
