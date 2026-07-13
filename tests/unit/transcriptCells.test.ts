import { describe, expect, it } from 'vitest';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import {
  buildConversationCells,
  type PendingPromptDescriptor,
} from '@/conversation/transcriptCells';

const NO_EXTRAS = { liveTailLines: null, pendingPrompt: null };

function buildEntries(): TranscriptEntryWire[] {
  return [
    { kind: 'user', uuid: 'u1', ts: 1, text: 'run the tests' },
    {
      kind: 'assistant',
      uuid: 'a1',
      ts: 2,
      model: 'claude-fable-5',
      blocks: [
        { type: 'text', text: 'On it.' },
        { type: 'thinking', text: 'Let me plan the run.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } },
      ],
    },
    { kind: 'tool_result', uuid: 'r1', ts: 3, toolUseId: 'toolu_1', content: '3 passed' },
    { kind: 'system', uuid: 's1', ts: 4, subtype: 'compaction', text: 'Context compacted' },
  ];
}

describe('buildConversationCells', () => {
  it('flattens entries into ordered cells with per-block keys', () => {
    const cells = buildConversationCells(buildEntries(), NO_EXTRAS);

    expect(cells.map((cell) => cell.kind)).toEqual([
      'user-message',
      'markdown',
      'thinking',
      'tool-call',
      'system-divider',
    ]);
    expect(cells.map((cell) => cell.key)).toEqual(['u1', 'a1:0', 'a1:1', 'a1:2', 's1']);
  });

  it('merges a tool_result into its tool-call cell and emits no cell for it', () => {
    const cells = buildConversationCells(buildEntries(), NO_EXTRAS);

    const toolCallCell = cells.find((cell) => cell.kind === 'tool-call');
    expect(toolCallCell).toBeDefined();
    if (toolCallCell?.kind !== 'tool-call') throw new Error('unreachable');
    expect(toolCallCell.toolUseId).toBe('toolu_1');
    expect(toolCallCell.toolName).toBe('Bash');
    expect(toolCallCell.input).toEqual({ command: 'npm test' });
    expect(toolCallCell.result).toEqual({ content: '3 passed', isError: false });
  });

  it('leaves result null for a tool_use with no matching tool_result', () => {
    const entries: TranscriptEntryWire[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 1,
        blocks: [{ type: 'tool_use', id: 'toolu_pending', name: 'Read', input: { file_path: 'x' } }],
      },
    ];

    const cells = buildConversationCells(entries, NO_EXTRAS);

    expect(cells).toHaveLength(1);
    if (cells[0].kind !== 'tool-call') throw new Error('unreachable');
    expect(cells[0].result).toBeNull();
  });

  it('preserves an error flag when merging results', () => {
    const entries: TranscriptEntryWire[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 1,
        blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'exit 1' } }],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 2, toolUseId: 'toolu_1', content: 'boom', isError: true },
    ];

    const cells = buildConversationCells(entries, NO_EXTRAS);

    if (cells[0].kind !== 'tool-call') throw new Error('unreachable');
    expect(cells[0].result).toEqual({ content: 'boom', isError: true });
  });

  it('renders a tool_result with no matching tool_use as an orphan cell', () => {
    const entries: TranscriptEntryWire[] = [
      { kind: 'tool_result', uuid: 'r-orphan', ts: 1, toolUseId: 'toolu_gone', content: 'lost', isError: true },
    ];

    const cells = buildConversationCells(entries, NO_EXTRAS);

    expect(cells).toEqual([
      { kind: 'tool-result-orphan', key: 'r-orphan', content: 'lost', isError: true },
    ]);
  });

  it('skips empty and whitespace-only text/thinking blocks without shifting later keys', () => {
    const entries: TranscriptEntryWire[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 1,
        blocks: [
          { type: 'text', text: '' },
          { type: 'thinking', text: '  \n\t ' },
          { type: 'text', text: 'visible' },
        ],
      },
    ];

    const cells = buildConversationCells(entries, NO_EXTRAS);

    expect(cells).toHaveLength(1);
    expect(cells[0].kind).toBe('markdown');
    // Key uses the ORIGINAL block index (2), not the post-skip index.
    expect(cells[0].key).toBe('a1:2');
  });

  it('produces identical keys across wholesale transcript re-pushes', () => {
    const firstPushKeys = buildConversationCells(buildEntries(), NO_EXTRAS).map((cell) => cell.key);
    const secondPushKeys = buildConversationCells(buildEntries(), NO_EXTRAS).map((cell) => cell.key);
    expect(secondPushKeys).toEqual(firstPushKeys);

    const extendedEntries: TranscriptEntryWire[] = [
      ...buildEntries(),
      { kind: 'user', uuid: 'u2', ts: 5, text: 'thanks' },
    ];
    const extendedKeys = buildConversationCells(extendedEntries, NO_EXTRAS).map((cell) => cell.key);
    expect(extendedKeys.slice(0, firstPushKeys.length)).toEqual(firstPushKeys);
  });

  it('omits the live-tail cell when lines are null or empty', () => {
    const withNull = buildConversationCells(buildEntries(), {
      liveTailLines: null,
      pendingPrompt: null,
    });
    const withEmpty = buildConversationCells(buildEntries(), {
      liveTailLines: [],
      pendingPrompt: null,
    });
    expect(withNull.some((cell) => cell.kind === 'live-tail')).toBe(false);
    expect(withEmpty.some((cell) => cell.kind === 'live-tail')).toBe(false);
  });

  it('appends the live-tail cell last when lines are present', () => {
    const cells = buildConversationCells(buildEntries(), {
      liveTailLines: ['token stream'],
      pendingPrompt: null,
    });

    const lastCell = cells[cells.length - 1];
    expect(lastCell).toEqual({ kind: 'live-tail', key: 'live-tail', lines: ['token stream'] });
  });

  it('appends the pending prompt cell after the live-tail cell', () => {
    const prompt: PendingPromptDescriptor = {
      promptId: 'sess:toolu_1',
      sessionId: 'sess',
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
    };

    const cells = buildConversationCells(buildEntries(), {
      liveTailLines: ['streaming'],
      pendingPrompt: prompt,
    });

    expect(cells[cells.length - 2].kind).toBe('live-tail');
    expect(cells[cells.length - 1]).toEqual({
      kind: 'permission-prompt',
      key: 'prompt-sess:toolu_1',
      prompt,
    });
  });

  it('uses the ask-user-question kind when the awaited tool is AskUserQuestion', () => {
    const prompt: PendingPromptDescriptor = {
      promptId: 'sess:toolu_q',
      sessionId: 'sess',
      toolUseId: 'toolu_q',
      toolName: 'AskUserQuestion',
      input: { questions: [] },
    };

    const cells = buildConversationCells([], { liveTailLines: null, pendingPrompt: prompt });

    expect(cells).toEqual([{ kind: 'ask-user-question', key: 'prompt-sess:toolu_q', prompt }]);
  });

  it('falls back to permission-prompt when the awaited tool is unknown', () => {
    const prompt: PendingPromptDescriptor = {
      promptId: 'sess:mystery',
      sessionId: 'sess',
      toolUseId: null,
      toolName: null,
      input: null,
    };

    const cells = buildConversationCells([], { liveTailLines: null, pendingPrompt: prompt });

    expect(cells[0].kind).toBe('permission-prompt');
  });
});
