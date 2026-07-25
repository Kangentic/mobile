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
  /**
   * The dialog's numbered option labels as detected by the desktop's PTY
   * probe (protocol 0.6.0 `awaitedPromptOptions`/`options`).
   *
   * Carried on the wire but deliberately NOT rendered: a scraped label is a
   * guess at what a keystroke does, and offering it as a tappable answer
   * invites approving something other than what the row says. The prompt card
   * decides its own fallback from `toolName` instead - null there means the
   * prompt could not be identified, and the card shows the terminal escape
   * hatch rather than an Approve button.
   */
  options: string[] | null;
}

type UserEntryWire = Extract<TranscriptEntryWire, { kind: 'user' }>;

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

/**
 * A shared header (role badge, model, sent time) for the whole turn - only
 * populated on the turn's first/solo cell (every user turn is solo). A turn
 * is one user entry or the run of visible blocks from one assistant entry,
 * so a multi-block assistant turn (text + several tool calls) reads as ONE
 * bordered card with the header on top, not one card per block. `agentName`
 * and `model` are null on a user turn - the header renders a fixed "You"
 * badge instead.
 */
export interface TurnHeaderInfo {
  agentName: string | null;
  model: string | null;
  ts: number;
}

export interface TurnMeta {
  role: 'user' | 'assistant';
  position: 'solo' | 'first' | 'middle' | 'last';
  header?: TurnHeaderInfo;
}

export type ConversationCell =
  | { kind: 'user-message'; key: string; entry: UserEntryWire; turn: TurnMeta }
  | { kind: 'markdown'; key: string; entryUuid: string; text: string; turn: TurnMeta }
  | { kind: 'thinking'; key: string; entryUuid: string; text: string; turn: TurnMeta }
  | {
      kind: 'tool-call';
      key: string;
      entryUuid: string;
      toolUseId: string;
      toolName: string;
      input: JsonValue;
      result: ToolCallResult | null;
      turn: TurnMeta;
    }
  | { kind: 'tool-result-orphan'; key: string; content: string; isError: boolean }
  | { kind: 'system-divider'; key: string; subtype: TranscriptSystemSubtypeWire; text: string }
  | { kind: 'live-tail'; key: 'live-tail'; lines: string[] }
  | { kind: 'permission-prompt'; key: string; prompt: PendingPromptDescriptor }
  | { kind: 'ask-user-question'; key: string; prompt: PendingPromptDescriptor };

/** Only a multi-block turn needs first/middle/last; a single visible block is always `solo`. */
function turnPositionFor(index: number, length: number): TurnMeta['position'] {
  if (length <= 1) return 'solo';
  if (index === 0) return 'first';
  if (index === length - 1) return 'last';
  return 'middle';
}

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
        cells.push({
          kind: 'user-message',
          key: entry.uuid,
          entry,
          turn: { role: 'user', position: 'solo', header: { agentName: null, model: null, ts: entry.ts } },
        });
        break;
      }
      case 'assistant': {
        // Two passes: first collect the entry's VISIBLE blocks (skipping
        // empty text/thinking and the awaited-pending tool_use, same as
        // before), then assign first/middle/last from that visible list so
        // the whole run renders as one bordered turn card, not one per block.
        type AssistantBlockDraft =
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
            };
        const drafts: AssistantBlockDraft[] = [];
        for (let blockIndex = 0; blockIndex < entry.blocks.length; blockIndex++) {
          const block = entry.blocks[blockIndex];
          // Keys use the ORIGINAL block index so skipping empty blocks never
          // shifts the keys of later blocks in the same entry.
          const blockKey = `${entry.uuid}:${blockIndex}`;
          if (block.type === 'text') {
            if (block.text.trim().length === 0) {
              continue;
            }
            drafts.push({ kind: 'markdown', key: blockKey, entryUuid: entry.uuid, text: block.text });
          } else if (block.type === 'thinking') {
            if (block.text.trim().length === 0) {
              continue;
            }
            drafts.push({ kind: 'thinking', key: blockKey, entryUuid: entry.uuid, text: block.text });
          } else {
            // The awaited tool_use lands in the transcript before the prompt
            // is raised (so the prompt card can show the exact command) -
            // suppress its plain tool-call cell while the prompt is pending,
            // or it renders twice: once as a normal call, once as the
            // prompt card. Once answered, pendingPrompt goes null and this
            // same cell reappears with its result (the natural consequence
            // of keying on the live pending prompt, not a special case).
            if (options.pendingPrompt !== null && options.pendingPrompt.toolUseId === block.id) {
              continue;
            }
            drafts.push({
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
        for (let draftIndex = 0; draftIndex < drafts.length; draftIndex++) {
          const position = turnPositionFor(draftIndex, drafts.length);
          const turn: TurnMeta =
            draftIndex === 0
              ? {
                  role: 'assistant',
                  position,
                  header: { agentName: entry.agentName ?? null, model: entry.model ?? null, ts: entry.ts },
                }
              : { role: 'assistant', position };
          cells.push({ ...drafts[draftIndex], turn });
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
