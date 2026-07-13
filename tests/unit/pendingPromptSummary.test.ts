import { describe, expect, it } from 'vitest';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import {
  buildPendingPromptSummary,
  extractAwaitedToolUseId,
  findAwaitedToolUse,
  parseAskUserQuestionInput,
} from '@/conversation/pendingPromptSummary';

const SESSION_ID = 'session-abc';

describe('extractAwaitedToolUseId', () => {
  it('extracts the toolUseId after the sessionId prefix', () => {
    expect(extractAwaitedToolUseId(SESSION_ID, `${SESSION_ID}:toolu_01`)).toBe('toolu_01');
  });

  it('keeps extra colons inside the toolUseId component', () => {
    expect(extractAwaitedToolUseId(SESSION_ID, `${SESSION_ID}:a:b`)).toBe('a:b');
  });

  it('returns null when the prefix is a different session', () => {
    expect(extractAwaitedToolUseId(SESSION_ID, 'other-session:toolu_01')).toBeNull();
  });

  it('returns null when the separator or remainder is missing', () => {
    expect(extractAwaitedToolUseId(SESSION_ID, SESSION_ID)).toBeNull();
    expect(extractAwaitedToolUseId(SESSION_ID, `${SESSION_ID}:`)).toBeNull();
  });
});

describe('findAwaitedToolUse', () => {
  const entries: TranscriptEntryWire[] = [
    { kind: 'user', uuid: 'u1', ts: 1, text: 'do the thing' },
    {
      kind: 'assistant',
      uuid: 'a1',
      ts: 2,
      blocks: [
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', id: 'toolu_early', name: 'Read', input: { file_path: 'a.ts' } },
      ],
    },
    { kind: 'tool_result', uuid: 'r1', ts: 3, toolUseId: 'toolu_early', content: 'contents' },
    {
      kind: 'assistant',
      uuid: 'a2',
      ts: 4,
      blocks: [{ type: 'tool_use', id: 'toolu_late', name: 'Bash', input: { command: 'ls' } }],
    },
  ];

  it('finds the tool_use block matching the awaited id', () => {
    const found = findAwaitedToolUse(entries, SESSION_ID, `${SESSION_ID}:toolu_late`);
    expect(found).toEqual({
      toolUseId: 'toolu_late',
      name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('finds an earlier tool_use when the awaited id points at it', () => {
    const found = findAwaitedToolUse(entries, SESSION_ID, `${SESSION_ID}:toolu_early`);
    expect(found?.name).toBe('Read');
  });

  it('returns null when no tool_use matches', () => {
    expect(findAwaitedToolUse(entries, SESSION_ID, `${SESSION_ID}:toolu_missing`)).toBeNull();
  });

  it('returns null when the awaitedPromptId belongs to another session', () => {
    expect(findAwaitedToolUse(entries, SESSION_ID, 'other:toolu_late')).toBeNull();
  });
});

describe('parseAskUserQuestionInput', () => {
  it('parses a fully-populated input', () => {
    const parsed = parseAskUserQuestionInput({
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: true,
          options: [
            { label: 'Fast', description: 'Ship it now' },
            { label: 'Careful', description: 'Take a week' },
          ],
        },
      ],
    });
    expect(parsed).toEqual({
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          multiSelect: true,
          options: [
            { label: 'Fast', description: 'Ship it now' },
            { label: 'Careful', description: 'Take a week' },
          ],
        },
      ],
    });
  });

  it('fills defaults for omitted optional fields', () => {
    const parsed = parseAskUserQuestionInput({
      questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }],
    });
    expect(parsed).toEqual({
      questions: [
        {
          question: 'Proceed?',
          header: null,
          multiSelect: false,
          options: [{ label: 'Yes', description: null }],
        },
      ],
    });
  });

  it('returns null on malformed shapes', () => {
    expect(parseAskUserQuestionInput(null)).toBeNull();
    expect(parseAskUserQuestionInput('questions')).toBeNull();
    expect(parseAskUserQuestionInput({})).toBeNull();
    expect(parseAskUserQuestionInput({ questions: [] })).toBeNull();
    expect(parseAskUserQuestionInput({ questions: [{ options: [] }] })).toBeNull();
    expect(parseAskUserQuestionInput({ questions: [{ question: 'Hi?' }] })).toBeNull();
    expect(
      parseAskUserQuestionInput({ questions: [{ question: 'Hi?', options: [{ label: 5 }] }] }),
    ).toBeNull();
    expect(
      parseAskUserQuestionInput({
        questions: [{ question: 'Hi?', header: 7, options: [{ label: 'A' }] }],
      }),
    ).toBeNull();
    expect(
      parseAskUserQuestionInput({
        questions: [{ question: 'Hi?', multiSelect: 'yes', options: [{ label: 'A' }] }],
      }),
    ).toBeNull();
  });
});

describe('buildPendingPromptSummary', () => {
  it('falls back to the generic string when no tool_use was located', () => {
    expect(buildPendingPromptSummary(null)).toBe('Waiting for your approval');
  });

  it('uses the first question text for AskUserQuestion', () => {
    const summary = buildPendingPromptSummary({
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'Which database should we use?', options: [{ label: 'SQLite' }] }] },
    });
    expect(summary).toBe('Which database should we use?');
  });

  it('falls back to the generic string for an unparseable AskUserQuestion input', () => {
    expect(buildPendingPromptSummary({ name: 'AskUserQuestion', input: { nope: true } })).toBe(
      'Waiting for your approval',
    );
  });

  it('summarizes Bash with the first line of the command', () => {
    const summary = buildPendingPromptSummary({
      name: 'Bash',
      input: { command: 'npm install\nnpm run build' },
    });
    expect(summary).toBe('Approve: npm install');
  });

  it('falls back to the bare tool name when Bash input has no command string', () => {
    expect(buildPendingPromptSummary({ name: 'Bash', input: {} })).toBe('Approve: Bash');
  });

  it('summarizes file tools with the basename of file_path', () => {
    expect(
      buildPendingPromptSummary({
        name: 'Edit',
        input: { file_path: 'C:\\Users\\dev\\repo\\src\\index.ts' },
      }),
    ).toBe('Approve: Edit index.ts');
    expect(
      buildPendingPromptSummary({ name: 'Write', input: { file_path: 'src/screens/Home.tsx' } }),
    ).toBe('Approve: Write Home.tsx');
    expect(buildPendingPromptSummary({ name: 'Read', input: { file_path: 'notes.md' } })).toBe(
      'Approve: Read notes.md',
    );
    expect(
      buildPendingPromptSummary({ name: 'NotebookEdit', input: { file_path: 'lab/analysis.ipynb' } }),
    ).toBe('Approve: NotebookEdit analysis.ipynb');
  });

  it('summarizes ExitPlanMode as a plan review', () => {
    expect(buildPendingPromptSummary({ name: 'ExitPlanMode', input: { plan: '...' } })).toBe(
      'Review the plan',
    );
  });

  it('summarizes any other tool by name', () => {
    expect(buildPendingPromptSummary({ name: 'WebFetch', input: { url: 'https://x' } })).toBe(
      'Approve: WebFetch',
    );
  });

  it('caps the summary at 80 characters with a three-dot ellipsis', () => {
    const summary = buildPendingPromptSummary({
      name: 'Bash',
      input: { command: 'x'.repeat(200) },
    });
    expect(summary.length).toBe(80);
    expect(summary.endsWith('...')).toBe(true);
    expect(summary.startsWith('Approve: xxx')).toBe(true);
  });
});
