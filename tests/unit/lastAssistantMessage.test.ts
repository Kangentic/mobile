/**
 * The agent's last message (task #130), the desktop's `message-preview.ts`
 * rule: the newest assistant entry with non-blank text, skipping thinking,
 * tool calls and the user's turns.
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import { lastAssistantMessage } from '@/conversation/lastAssistantMessage';

function assistant(uuid: string, blocks: Extract<TranscriptEntryWire, { kind: 'assistant' }>['blocks']): TranscriptEntryWire {
  return { kind: 'assistant', uuid, ts: 0, blocks };
}

describe('lastAssistantMessage', () => {
  it("reads the newest assistant entry's text", () => {
    const entries: TranscriptEntryWire[] = [
      assistant('first', [{ type: 'text', text: 'Looking at the cache first.' }]),
      { kind: 'user', uuid: 'question', ts: 1, text: 'What happens if the batch call fails?' },
      assistant('last', [{ type: 'text', text: 'One retry, then it falls back to the per-item path.' }]),
    ];
    expect(lastAssistantMessage(entries)).toBe('One retry, then it falls back to the per-item path.');
  });

  it('skips an assistant entry that carries only thinking or a tool call', () => {
    const entries: TranscriptEntryWire[] = [
      assistant('answer', [{ type: 'text', text: 'Shipped.' }]),
      assistant('tool', [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm test' } }]),
      { kind: 'tool_result', uuid: 'result', ts: 2, toolUseId: 'tool-1', content: 'passed' },
      assistant('thinking', [{ type: 'thinking', text: 'Done, I think.' }]),
    ];
    expect(lastAssistantMessage(entries)).toBe('Shipped.');
  });

  it('joins the text blocks of one entry and drops its thinking', () => {
    const entries: TranscriptEntryWire[] = [
      assistant('mixed', [
        { type: 'thinking', text: 'Plan the reply.' },
        { type: 'text', text: 'Cache is in.' },
        { type: 'tool_use', id: 'tool-2', name: 'Read', input: {} },
        { type: 'text', text: 'Cold render 240ms, cached 11ms.' },
      ]),
    ];
    expect(lastAssistantMessage(entries)).toBe('Cache is in.\nCold render 240ms, cached 11ms.');
  });

  it('skips blank text', () => {
    const entries: TranscriptEntryWire[] = [assistant('real', [{ type: 'text', text: 'Shipped.' }]), assistant('blank', [{ type: 'text', text: '  \n ' }])];
    expect(lastAssistantMessage(entries)).toBe('Shipped.');
  });

  it('is null when the window holds no assistant text', () => {
    expect(lastAssistantMessage([])).toBeNull();
    expect(lastAssistantMessage([{ kind: 'user', uuid: 'only', ts: 0, text: 'Hello' }])).toBeNull();
  });
});
