/**
 * Flattening TranscriptEntryWire[] into the cell list the conversation
 * FlashList renders. Pure and deterministic: the same entries always produce
 * the same cells with the same keys, so wholesale transcript re-pushes from
 * the desktop recycle list rows instead of remounting them.
 */
import type {
  JsonValue,
  TranscriptEntryWire,
  TranscriptSystemSubtypeWire,
} from '@kangentic/protocol';

export type PendingPromptCellKind = 'permission-prompt' | 'ask-user-question';

export interface PendingPromptDescriptor {
  promptId: string;
  sessionId: string;
  toolUseId: string | null;
  toolName: string | null;
  input: JsonValue | null;
}

type UserEntryWire = Extract<TranscriptEntryWire, { kind: 'user' }>;

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

export type ConversationCell =
  | { kind: 'user-message'; key: string; entry: UserEntryWire }
  | { kind: 'markdown'; key: string; entryUuid: string; text: string }
  | { kind: 'thinking'; key: string; entryUuid: string; text: string }
  | {
      kind: 'tool-call';
      key: string;
      entryUuid: string;
      toolUseId: string;
      toolName: string;
      input: JsonValue;
      result: ToolCallResult | null;
    }
  | { kind: 'tool-result-orphan'; key: string; content: string; isError: boolean }
  | { kind: 'system-divider'; key: string; subtype: TranscriptSystemSubtypeWire; text: string }
  | { kind: 'live-tail'; key: 'live-tail'; lines: string[] }
  | { kind: 'permission-prompt'; key: string; prompt: PendingPromptDescriptor }
  | { kind: 'ask-user-question'; key: string; prompt: PendingPromptDescriptor };

export interface BuildConversationCellsOptions {
  liveTailLines: string[] | null;
  pendingPrompt: PendingPromptDescriptor | null;
}

interface IndexedToolResult {
  entryIndex: number;
  content: string;
  isError: boolean;
}

export function buildConversationCells(
  entries: TranscriptEntryWire[],
  options: BuildConversationCellsOptions,
): ConversationCell[] {
  // Pre-index tool_result entries and tool_use ids so merging is one pass.
  const toolResultsByToolUseId = new Map<string, IndexedToolResult[]>();
  const toolUseIdEarliestIndex = new Map<string, number>();
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (entry.kind === 'tool_result') {
      const resultsForId = toolResultsByToolUseId.get(entry.toolUseId) ?? [];
      resultsForId.push({
        entryIndex,
        content: entry.content,
        isError: entry.isError ?? false,
      });
      toolResultsByToolUseId.set(entry.toolUseId, resultsForId);
    } else if (entry.kind === 'assistant') {
      for (const block of entry.blocks) {
        if (block.type === 'tool_use' && !toolUseIdEarliestIndex.has(block.id)) {
          toolUseIdEarliestIndex.set(block.id, entryIndex);
        }
      }
    }
  }

  function findResultAfter(toolUseId: string, entryIndex: number): ToolCallResult | null {
    const resultsForId = toolResultsByToolUseId.get(toolUseId);
    if (resultsForId === undefined) {
      return null;
    }
    for (const indexedResult of resultsForId) {
      if (indexedResult.entryIndex > entryIndex) {
        return { content: indexedResult.content, isError: indexedResult.isError };
      }
    }
    return null;
  }

  const cells: ConversationCell[] = [];

  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    switch (entry.kind) {
      case 'user': {
        cells.push({ kind: 'user-message', key: entry.uuid, entry });
        break;
      }
      case 'assistant': {
        for (let blockIndex = 0; blockIndex < entry.blocks.length; blockIndex++) {
          const block = entry.blocks[blockIndex];
          // Keys use the ORIGINAL block index so skipping empty blocks never
          // shifts the keys of later blocks in the same entry.
          const blockKey = `${entry.uuid}:${blockIndex}`;
          if (block.type === 'text') {
            if (block.text.trim().length === 0) {
              continue;
            }
            cells.push({ kind: 'markdown', key: blockKey, entryUuid: entry.uuid, text: block.text });
          } else if (block.type === 'thinking') {
            if (block.text.trim().length === 0) {
              continue;
            }
            cells.push({ kind: 'thinking', key: blockKey, entryUuid: entry.uuid, text: block.text });
          } else {
            cells.push({
              kind: 'tool-call',
              key: blockKey,
              entryUuid: entry.uuid,
              toolUseId: block.id,
              toolName: block.name,
              input: block.input,
              result: findResultAfter(block.id, entryIndex),
            });
          }
        }
        break;
      }
      case 'tool_result': {
        // Merged into the matching tool-call cell; only an orphan (no
        // tool_use anywhere earlier) renders as its own cell.
        const matchingToolUseIndex = toolUseIdEarliestIndex.get(entry.toolUseId);
        if (matchingToolUseIndex === undefined || matchingToolUseIndex >= entryIndex) {
          cells.push({
            kind: 'tool-result-orphan',
            key: entry.uuid,
            content: entry.content,
            isError: entry.isError ?? false,
          });
        }
        break;
      }
      case 'system': {
        cells.push({
          kind: 'system-divider',
          key: entry.uuid,
          subtype: entry.subtype,
          text: entry.text,
        });
        break;
      }
    }
  }

  if (options.liveTailLines !== null && options.liveTailLines.length > 0) {
    cells.push({ kind: 'live-tail', key: 'live-tail', lines: options.liveTailLines });
  }

  if (options.pendingPrompt !== null) {
    const prompt = options.pendingPrompt;
    const promptCellKind: PendingPromptCellKind =
      prompt.toolName === 'AskUserQuestion' ? 'ask-user-question' : 'permission-prompt';
    cells.push({ kind: promptCellKind, key: `prompt-${prompt.promptId}`, prompt });
  }

  return cells;
}
