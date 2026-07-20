/**
 * Locating and summarizing the prompt a session is paused on. The desktop
 * signals a pause with activity state 'permission' plus an awaitedPromptId of
 * the form `${sessionId}:${toolUseId}`; the transcript's matching tool_use
 * block carries the tool name and input the phone summarizes on the triage
 * card and expands in the conversation view.
 */
import { isRecord, type JsonValue, type TranscriptEntryWire } from '@kangentic/protocol';
import { splitPathForDisplay } from '@/diff/pathDisplay';

const SUMMARY_MAX_LENGTH = 80;
const GENERIC_SUMMARY = 'Waiting for your approval';

/** Tools whose one-line summary shows the basename of `input.file_path`. */
const FILE_PATH_TOOL_NAMES = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);

/**
 * Extract the toolUseId from an awaitedPromptId (`${sessionId}:${toolUseId}`).
 * Returns null when the prefix does not match `sessionId + ':'` or the
 * remainder is empty.
 */
export function extractAwaitedToolUseId(
  sessionId: string,
  awaitedPromptId: string,
): string | null {
  const expectedPrefix = `${sessionId}:`;
  if (!awaitedPromptId.startsWith(expectedPrefix)) {
    return null;
  }
  const toolUseId = awaitedPromptId.slice(expectedPrefix.length);
  return toolUseId.length > 0 ? toolUseId : null;
}

export interface AwaitedToolUse {
  toolUseId: string;
  name: string;
  input: JsonValue;
}

const SNIPPET_MAX_LENGTH = 200;

/**
 * The last assistant text in a transcript window, whitespace-collapsed to
 * a short inbox-style snippet, or null when the window has no assistant
 * text. Powers the Agents feed's idle-card message preview.
 */
export function lastAssistantText(entries: TranscriptEntryWire[]): string | null {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = entries[entryIndex];
    if (entry.kind !== 'assistant') continue;
    for (let blockIndex = entry.blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = entry.blocks[blockIndex];
      if (block.type === 'text' && block.text.trim().length > 0) {
        return block.text.trim().replace(/\s+/g, ' ').slice(0, SNIPPET_MAX_LENGTH);
      }
    }
  }
  return null;
}

/**
 * Scan the transcript BACKWARDS (the awaited tool_use is almost always in
 * the final assistant entry) for the assistant tool_use block whose id
 * matches the awaitedPromptId's toolUseId component.
 */
export function findAwaitedToolUse(
  entries: TranscriptEntryWire[],
  sessionId: string,
  awaitedPromptId: string,
): AwaitedToolUse | null {
  const toolUseId = extractAwaitedToolUseId(sessionId, awaitedPromptId);
  if (toolUseId === null) {
    return null;
  }
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = entries[entryIndex];
    if (entry.kind !== 'assistant') {
      continue;
    }
    for (const block of entry.blocks) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return { toolUseId, name: block.name, input: block.input };
      }
    }
  }
  return null;
}

export interface AskUserQuestionOption {
  label: string;
  description: string | null;
}

export interface AskUserQuestionQuestion {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: AskUserQuestionOption[];
}

export interface AskUserQuestionInput {
  questions: AskUserQuestionQuestion[];
}

function parseAskUserQuestionOption(value: unknown): AskUserQuestionOption | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.label !== 'string') {
    return null;
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    return null;
  }
  return { label: value.label, description: value.description ?? null };
}

function parseAskUserQuestionQuestion(value: unknown): AskUserQuestionQuestion | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.question !== 'string') {
    return null;
  }
  if (value.header !== undefined && typeof value.header !== 'string') {
    return null;
  }
  if (value.multiSelect !== undefined && typeof value.multiSelect !== 'boolean') {
    return null;
  }
  if (!Array.isArray(value.options)) {
    return null;
  }
  const options: AskUserQuestionOption[] = [];
  for (const optionValue of value.options) {
    const option = parseAskUserQuestionOption(optionValue);
    if (option === null) {
      return null;
    }
    options.push(option);
  }
  return {
    question: value.question,
    header: value.header ?? null,
    multiSelect: value.multiSelect ?? false,
    options,
  };
}

/**
 * Defensively parse an AskUserQuestion tool input. Returns null on any
 * malformed shape (including an empty questions array) so the caller can
 * fall back to a generic prompt card.
 */
export function parseAskUserQuestionInput(input: JsonValue): AskUserQuestionInput | null {
  if (!isRecord(input)) {
    return null;
  }
  if (!Array.isArray(input.questions) || input.questions.length === 0) {
    return null;
  }
  const questions: AskUserQuestionQuestion[] = [];
  for (const questionValue of input.questions) {
    const question = parseAskUserQuestionQuestion(questionValue);
    if (question === null) {
      return null;
    }
    questions.push(question);
  }
  return { questions };
}

function capSummary(summary: string): string {
  if (summary.length <= SUMMARY_MAX_LENGTH) {
    return summary;
  }
  return `${summary.slice(0, SUMMARY_MAX_LENGTH - 3)}...`;
}

function firstLineOf(text: string): string {
  const newlineIndex = text.indexOf('\n');
  const firstLine = newlineIndex >= 0 ? text.slice(0, newlineIndex) : text;
  return firstLine.trim();
}

/**
 * One-line triage-card summary of the awaited prompt. Falls back to a
 * generic string whenever the tool_use could not be located or its input is
 * not the shape the summarizer expects.
 */
export function buildPendingPromptSummary(
  toolUse: { name: string; input: JsonValue } | null,
): string {
  if (toolUse === null) {
    return GENERIC_SUMMARY;
  }
  const { name, input } = toolUse;
  if (name === 'AskUserQuestion') {
    const parsedInput = parseAskUserQuestionInput(input);
    if (parsedInput === null) {
      return GENERIC_SUMMARY;
    }
    return capSummary(parsedInput.questions[0].question);
  }
  if (name === 'ExitPlanMode') {
    return 'Review the plan';
  }
  if (name === 'Bash' && isRecord(input) && typeof input.command === 'string') {
    return capSummary(`Approve: ${firstLineOf(input.command)}`);
  }
  if (FILE_PATH_TOOL_NAMES.has(name) && isRecord(input) && typeof input.file_path === 'string') {
    const { basename } = splitPathForDisplay(input.file_path);
    return capSummary(`Approve: ${name} ${basename}`);
  }
  return capSummary(`Approve: ${name}`);
}
