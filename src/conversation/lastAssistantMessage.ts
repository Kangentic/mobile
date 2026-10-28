import type { TranscriptEntryWire } from '@kangentic/protocol';

/**
 * The agent's last message in a transcript: the newest assistant entry whose
 * text blocks, joined with a newline, are not blank. Thinking and tool calls
 * are skipped, and so is an assistant entry that carries only those.
 *
 * The desktop's rule (`src/main/agent/shared/message-preview.ts`), which its
 * completed task view shows under "Last message" when no task summary is
 * written. The phone reads it from the transcript window it already loaded
 * for the Conversation segment, so it adds no request; a window that holds no
 * assistant text yields null.
 */
export function lastAssistantMessage(entries: readonly TranscriptEntryWire[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.kind !== 'assistant') continue;
    const text = entry.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}
