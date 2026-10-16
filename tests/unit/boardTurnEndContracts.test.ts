/**
 * Pins the final-line contracts between the board's On agent turn end rows in kangentic.json and
 * the script and skills that print those lines.
 *
 * A Text match row (`finalLine`) moves a card only when the WHOLE last line of the agent's final
 * message matches it. When a row and the line its producer prints drift apart (a reworded skill, a
 * renamed row, the verdict printed above its steps again), nothing errors anywhere: the card just
 * waits in its column. This is the mechanical half of CLAUDE.md's "change the row and the skill
 * together":
 *
 * 1. Code Review: the verdict script's closing block, and the summary the skill pastes verbatim,
 *    END on exactly the Back for revisions and On to Testing lines, for both verdicts. Exact
 *    equality is stricter than the desktop matcher (which ignores case and punctuation) on
 *    purpose: the script is deterministic, so the matcher's leniency is never what makes this pass.
 * 2. Back for revisions carries the review's reply, which is where its numbered steps are.
 * 3. Testing: /pull-request prints the On to Merge line and names the row that reads it.
 * 4. Executing: the Apply findings message asks for exactly the lines the other two rows match.
 * 5. Merge: /merge-pull-request prints the Finish line and names the row that reads it.
 * 6. Every row is well formed: a Text match only on a turn-end row, never beside a condition, and
 *    every Move to column target is a column that exists.
 * 7. Every Text match row's routing (type, target column, run cap) is pinned in one table, and the
 *    table must list exactly the rows that carry a finalLine, so a new or removed row fails by name.
 * 8. Executing ends on the unconditional Apply findings message, so the move that ends the group
 *    is checked before the message is sent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderClosingBlock, renderSummary } from '../../scripts/review-verdict.mjs';

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');

interface AutomationRow {
  name: string;
  type: string;
  finalLine?: string;
  condition?: string;
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

function turnEndRows(columnName: string): AutomationRow[] {
  const column = board.columns.find((candidate) => candidate.name === columnName);
  if (!column) throw new Error(`kangentic.json has no "${columnName}" column`);
  return column.automations?.onTurnEnd ?? [];
}

function turnEndRow(columnName: string, rowName: string): AutomationRow {
  const row = turnEndRows(columnName).find((candidate) => candidate.name === rowName);
  if (!row) throw new Error(`kangentic.json's ${columnName} column has no "${rowName}" turn-end row`);
  return row;
}

function finalLineOf(columnName: string, rowName: string): string {
  const { finalLine } = turnEndRow(columnName, rowName);
  if (finalLine === undefined) throw new Error(`the ${columnName} "${rowName}" row has no finalLine`);
  return finalLine;
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
      location: 'src/channel/relay.ts:30',
      file: 'src/channel/relay.ts',
      mechanism: 'reply parsed before the handshake settles',
      status: 'blocked',
      reason: 'needs a real reply',
      step: 'capture a real reply into a fixture under src/devsupport/',
    },
  ],
};

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
  it('asks the agent for exactly the lines the Executing rows match', () => {
    const applyFindingsMessage = turnEndRow('Executing', 'Apply findings').message ?? '';
    const sourceName = 'the Apply findings message';
    expectTextIn(applyFindingsMessage, sourceName, `"${finalLineOf('Executing', 'On to Code Review')}"`);
    expectTextIn(applyFindingsMessage, sourceName, `"${finalLineOf('Executing', 'Design hold')}"`);
    expectTextIn(applyFindingsMessage, sourceName, 'final line, alone');
  });

  it('ends on Apply findings, the unconditional catch-all checked after the On to Code Review move', () => {
    const rows = turnEndRows('Executing');
    const applyFindings = turnEndRow('Executing', 'Apply findings');
    expect(applyFindings.type).toBe('send_message');
    expect(applyFindings.finalLine).toBeUndefined();
    expect(applyFindings.condition).toBeUndefined();
    expect(rows[rows.length - 1].name).toBe('Apply findings');
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
  type: string;
  targetColumn?: string;
  maxRuns?: number;
}

// Every row with a finalLine and where it sends the card. An absent field here must be absent in
// kangentic.json too. The test below keeps this list and the board the same set of rows.
const TEXT_MATCH_ROUTES: readonly TextMatchRoute[] = [
  { columnName: 'Executing', rowName: 'On to Code Review', type: 'move_to_column', targetColumn: 'Code Review', maxRuns: 4 },
  { columnName: 'Executing', rowName: 'Design hold', type: 'notify' },
  { columnName: 'Code Review', rowName: 'Back for revisions', type: 'move_to_column', targetColumn: 'Executing', maxRuns: 3 },
  { columnName: 'Code Review', rowName: 'On to Testing', type: 'move_to_column', targetColumn: 'Testing', maxRuns: 1 },
  { columnName: 'Testing', rowName: 'On to Merge', type: 'move_to_column', targetColumn: 'Merge', maxRuns: 1 },
  { columnName: 'Merge', rowName: 'Finish', type: 'move_to_column', targetColumn: 'Done', maxRuns: 1 },
];

describe('board turn-end contracts: row shape', () => {
  const columnNames = new Set(board.columns.map((column) => column.name));
  const everyRow = board.columns.flatMap((column) =>
    Object.entries(column.automations ?? {}).flatMap(([trigger, rows]) =>
      rows.map((row) => ({ columnName: column.name, trigger, row })),
    ),
  );

  // The listed set is never empty, so an emptied board cannot pass this vacuously.
  it('has a finalLine on exactly the rows TEXT_MATCH_ROUTES pins, no more and no fewer', () => {
    expect(TEXT_MATCH_ROUTES.length).toBeGreaterThan(0);
    const rowKey = (columnName: string, rowName: string): string => `${columnName} / ${rowName}`;
    const boardKeys = everyRow
      .filter(({ row }) => row.finalLine !== undefined)
      .map(({ columnName, row }) => rowKey(columnName, row.name))
      .sort();
    const pinnedKeys = TEXT_MATCH_ROUTES.map(({ columnName, rowName }) => rowKey(columnName, rowName)).sort();
    expect(boardKeys).toEqual(pinnedKeys);
  });

  it.each(TEXT_MATCH_ROUTES)('routes $columnName "$rowName" as pinned', (route) => {
    const row = turnEndRow(route.columnName, route.rowName);
    const label = `${route.columnName} "${route.rowName}"`;
    expect(row.type, label).toBe(route.type);
    // toBe(undefined) is toBeUndefined: a pinned-absent field must be absent on the row.
    expect(row.targetColumn, label).toBe(route.targetColumn);
    expect(row.maxRuns, label).toBe(route.maxRuns);
  });

  it('puts a Text match only on a turn-end row, never beside a condition', () => {
    for (const { columnName, trigger, row } of everyRow) {
      if (row.finalLine === undefined) continue;
      expect(trigger, `${columnName} "${row.name}"`).toBe('onTurnEnd');
      expect(row.condition, `${columnName} "${row.name}"`).toBeUndefined();
    }
  });

  it('moves only to a column the board has', () => {
    for (const { columnName, row } of everyRow) {
      if (row.type !== 'move_to_column') continue;
      expect(columnNames.has(row.targetColumn ?? ''), `${columnName} "${row.name}" -> ${row.targetColumn}`).toBe(true);
    }
  });
});
