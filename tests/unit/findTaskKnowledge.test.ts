/**
 * The `find_task` fallback's reader (task #130): what an older desktop's
 * finished task row says, narrowed from JSON. Shapes follow the desktop's
 * `search-commands.ts` and `task-knowledge.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@kangentic/protocol';
import { parseFindTaskKnowledge } from '@/taskReport/findTaskKnowledge';

const TASK_ID = '603d7042-f8aa-4ab8-860f-0f389edf25bb';

function findTaskResult(knowledge: JsonValue, id = TASK_ID): JsonValue {
  return {
    tasks: [{ id, displayId: 905, title: 'Fix the CI flake', column: 'Done', status: 'completed', knowledge }],
    backlog: [],
  };
}

const KNOWLEDGE: JsonValue = {
  summary: { text: 'Fixed CI failures from the v0.50.0 release.', writtenAt: '2026-10-26T15:00:00.000Z' },
  commits: [
    { sha: '1002e46f7e60ac84c19dff73b561faa35a21c4a7', subject: "test(review): pin navigateToVite's retry", committedAt: '2026-10-26T14:32:46.000Z' },
    { sha: '5d1d242100314beae31880f944ab1f79f8b54640', subject: "fix(ci): skip onnxruntime's CUDA download", committedAt: '2026-10-26T14:32:46.000Z' },
  ],
  commitCount: 3,
  changedFiles: ['tests/ui/helpers.ts', 'build/afterPack.js'],
  changedFileCount: 20,
};

describe('parseFindTaskKnowledge', () => {
  it("reads a finished task's summary, capped commits and paths, and their full counts", () => {
    expect(parseFindTaskKnowledge(findTaskResult(KNOWLEDGE), TASK_ID)).toEqual({
      summaryText: 'Fixed CI failures from the v0.50.0 release.',
      commits: [
        { sha: '1002e46f7e60ac84c19dff73b561faa35a21c4a7', subject: "test(review): pin navigateToVite's retry", committedAt: '2026-10-26T14:32:46.000Z' },
        { sha: '5d1d242100314beae31880f944ab1f79f8b54640', subject: "fix(ci): skip onnxruntime's CUDA download", committedAt: '2026-10-26T14:32:46.000Z' },
      ],
      commitCount: 3,
      changedFiles: ['tests/ui/helpers.ts', 'build/afterPack.js'],
      changedFileCount: 20,
    });
  });

  it('reads null knowledge (the index is off or could not be read) as nothing known', () => {
    expect(parseFindTaskKnowledge(findTaskResult(null), TASK_ID)).toBeNull();
  });

  it('reads no written summary as null, since find_task cannot say pending from off', () => {
    const knowledge = { ...(KNOWLEDGE as Record<string, JsonValue>), summary: null };
    expect(parseFindTaskKnowledge(findTaskResult(knowledge), TASK_ID)?.summaryText).toBeNull();
  });

  it('reads a blank summary as none written', () => {
    const knowledge = { ...(KNOWLEDGE as Record<string, JsonValue>), summary: { text: '   ', writtenAt: '2026-10-26T15:00:00.000Z' } };
    expect(parseFindTaskKnowledge(findTaskResult(knowledge), TASK_ID)?.summaryText).toBeNull();
  });

  it('reads only the row for the asked task, never a neighbor the search also matched', () => {
    const result: JsonValue = {
      tasks: [
        { id: 'another-task', knowledge: { summary: { text: 'Not this one', writtenAt: '' }, commits: [], commitCount: 0, changedFiles: [], changedFileCount: 0 } },
        { id: TASK_ID, knowledge: KNOWLEDGE },
      ],
      backlog: [],
    };
    expect(parseFindTaskKnowledge(result, TASK_ID)?.summaryText).toBe('Fixed CI failures from the v0.50.0 release.');
  });

  it('reads no matching row as nothing known', () => {
    expect(parseFindTaskKnowledge(findTaskResult(KNOWLEDGE, 'another-task'), TASK_ID)).toBeNull();
    expect(parseFindTaskKnowledge({ tasks: [], backlog: [] }, TASK_ID)).toBeNull();
  });

  it("reads the mock desktop's generic { note } answer, and any other shape, as nothing known", () => {
    expect(parseFindTaskKnowledge({ note: 'find_task completed.' }, TASK_ID)).toBeNull();
    expect(parseFindTaskKnowledge(null, TASK_ID)).toBeNull();
    expect(parseFindTaskKnowledge('find_task', TASK_ID)).toBeNull();
    expect(parseFindTaskKnowledge({ tasks: 'none' }, TASK_ID)).toBeNull();
  });

  it('drops a malformed commit or path on its own and keeps the rest', () => {
    const knowledge: JsonValue = {
      summary: null,
      commits: [{ sha: 'abc', subject: 7, committedAt: '2026-10-26T14:32:46.000Z' }, knowledgeCommitRow(), 'not a commit'],
      commitCount: 'many',
      changedFiles: ['src/a.ts', 42, '', 'src/b.ts'],
      changedFileCount: null,
    };
    const parsed = parseFindTaskKnowledge(findTaskResult(knowledge), TASK_ID);
    expect(parsed?.commits).toHaveLength(1);
    expect(parsed?.commitCount).toBe(1);
    expect(parsed?.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(parsed?.changedFileCount).toBe(2);
  });

  it('never reports fewer in all than it lists', () => {
    const knowledge = { ...(KNOWLEDGE as Record<string, JsonValue>), commitCount: 0, changedFileCount: 1 };
    const parsed = parseFindTaskKnowledge(findTaskResult(knowledge), TASK_ID);
    expect(parsed?.commitCount).toBe(2);
    expect(parsed?.changedFileCount).toBe(2);
  });
});

function knowledgeCommitRow(): JsonValue {
  return { sha: '777089fbb8bd3554939eee2b716f47df6709f4e2', subject: 'test(ui): order screencast frames', committedAt: '2026-10-26T14:32:46.000Z' };
}
