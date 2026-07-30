/**
 * The mock's chat transcript must exercise every shape a real Claude Code
 * session produces, because `dev:mock` is both the UI development rig and the
 * source for the chat store screenshot.
 *
 * Measured before this existed, the mock emitted three of the four
 * `TranscriptEntryWire` kinds, two of the three `TranscriptBlockWire` variants,
 * and exactly two tool names. So `ThinkingCell`, `SystemDividerCell`, the
 * error-state glyph and border, and every per-tool summary branch other than
 * Bash and Edit were unreachable in the one mode anybody previews in.
 *
 * ASSERTIONS RUN ON THE FLATTENED CELLS, NOT THE WIRE ENTRIES. A fixture-shape
 * test passes just as happily when `buildConversationCells` silently drops a
 * shape, which is the failure that would actually reach a screenshot.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptBlockWire, TranscriptEntryWire } from '@kangentic/protocol';
import { parseTranscriptEntriesWire } from '@kangentic/protocol';

import { baseTranscriptForTest } from '@/connection/mockDesktop';
import { buildConversationCells } from '@/conversation/transcriptCells';

const entries: TranscriptEntryWire[] = baseTranscriptForTest();
const cells = buildConversationCells(entries, { liveTailLines: null, pendingPrompt: null });

function blocksOf(entry: TranscriptEntryWire): readonly TranscriptBlockWire[] {
  return entry.kind === 'assistant' ? entry.blocks : [];
}

describe('the mock transcript is a valid wire payload', () => {
  it('parses with the protocol package own guard', () => {
    // Correct BY CONSTRUCTION rather than by inspection: the same parser the
    // phone runs on a real desktop frame has to accept this fixture, so a
    // hand-authored entry that drifts from the wire contract fails here.
    expect(() => parseTranscriptEntriesWire(JSON.parse(JSON.stringify(entries)))).not.toThrow();
  });
});

describe('the mock transcript covers every wire shape', () => {
  it('emits all four TranscriptEntryWire kinds', () => {
    const kinds = new Set(entries.map((entry) => entry.kind));
    expect([...kinds].sort()).toEqual(['assistant', 'system', 'tool_result', 'user']);
  });

  it('emits all three TranscriptBlockWire variants', () => {
    const types = new Set(entries.flatMap((entry) => blocksOf(entry).map((block) => block.type)));
    expect([...types].sort()).toEqual(['text', 'thinking', 'tool_use']);
  });

  it('carries per-turn token usage on assistant turns', () => {
    const assistantTurns = entries.filter((entry) => entry.kind === 'assistant');
    const withUsage = assistantTurns.filter((entry) => entry.kind === 'assistant' && entry.usage !== undefined);
    expect(withUsage.length).toBeGreaterThan(0);
  });

  it('names every assistant turn, so the badge never falls back mid-session', () => {
    const anonymous = entries
      .filter((entry) => entry.kind === 'assistant')
      .filter((entry) => entry.kind === 'assistant' && (entry.agentName === undefined || entry.model === undefined))
      .map((entry) => entry.uuid);
    expect(anonymous).toEqual([]);
  });

  it('includes a failing tool result', () => {
    const failures = entries.filter((entry) => entry.kind === 'tool_result' && entry.isError === true);
    expect(failures.length).toBeGreaterThan(0);
  });

  it('uses the tool names a real session is dominated by', () => {
    const toolNames = new Set(
      entries.flatMap((entry) =>
        blocksOf(entry).flatMap((block) => (block.type === 'tool_use' ? [block.name] : [])),
      ),
    );
    // Not an exhaustive list - the point is that it is no longer just Edit and
    // Bash, and that each of these takes a different branch in ToolCallCard.
    for (const expected of ['Read', 'Grep', 'Edit', 'Write', 'Bash', 'TodoWrite', 'Task']) {
      expect([...toolNames]).toContain(expected);
    }
    expect([...toolNames].some((name) => name.startsWith('mcp__'))).toBe(true);
  });
});

describe('the flattener actually renders those shapes', () => {
  it('produces a thinking cell', () => {
    expect(cells.some((cell) => cell.kind === 'thinking')).toBe(true);
  });

  it('produces a system divider for each subtype the fixture carries', () => {
    const fixtureSubtypes = new Set(
      entries.flatMap((entry) => (entry.kind === 'system' ? [entry.subtype] : [])),
    );
    const renderedSubtypes = new Set(
      cells.flatMap((cell) => (cell.kind === 'system-divider' ? [cell.subtype] : [])),
    );
    expect(fixtureSubtypes.size).toBeGreaterThan(0);
    // Set equality both ways: a subtype the flattener drops is exactly the bug
    // a wire-shape-only test would miss.
    expect([...renderedSubtypes].sort()).toEqual([...fixtureSubtypes].sort());
  });

  it('produces tool-call cells carrying the error state through to the cell', () => {
    const failing = cells.filter((cell) => cell.kind === 'tool-call' && cell.result?.isError === true);
    expect(failing.length).toBeGreaterThan(0);
  });

  it('leaves no tool call unresolved and no result orphaned', () => {
    // An orphan means a result whose tool_use is missing or out of order, which
    // renders as a bare result card floating outside any turn.
    expect(cells.filter((cell) => cell.kind === 'tool-result-orphan')).toEqual([]);
    const pending = cells.filter((cell) => cell.kind === 'tool-call' && cell.result === null);
    expect(pending).toEqual([]);
  });

  it('produces user and markdown cells', () => {
    expect(cells.some((cell) => cell.kind === 'user-message')).toBe(true);
    expect(cells.some((cell) => cell.kind === 'markdown')).toBe(true);
  });
});
