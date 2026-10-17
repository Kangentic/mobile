/**
 * The workflow rules the phone ports from the desktop (protocol 0.21.0, task
 * #116). Expectations come from the desktop's own sources, not from the port:
 * workflow-lock.ts (who may move a card), board-workflow.ts (Archive),
 * workflow-waiting.ts (the waiting footer's words), workflow-graph.ts (the
 * color clamp), workflow-service.ts (the get_workflow shape) and
 * workflow-layout.ts (layers by longest path).
 */
import { describe, expect, it } from 'vitest';
import type { BoardTaskWorkflowWire, JsonValue } from '@kangentic/protocol';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { workflowAllowsMove, workflowBlocksArchive, workflowMoveTargetIds } from '@/workflow/workflowMove';
import {
  normalizeWorkflowState,
  workflowCountLabel,
  workflowSlotNumber,
  workflowStateLabel,
  workflowStripLabel,
} from '@/workflow/workflowState';
import { workflowWaitingFooter } from '@/workflow/workflowWaiting';
import {
  groupWorkflowMembers,
  parseWorkflowDetail,
  parseWorkflowList,
  workflowDoneCount,
  workflowRunDepths,
  workflowTally,
  type WorkflowDetail,
  type WorkflowMember,
} from '@/workflow/workflowView';

function workflowFixture(overrides: Partial<BoardTaskWorkflowWire> = {}): BoardTaskWorkflowWire {
  return {
    id: 'workflow-1',
    title: 'Checkout hardening',
    project_id: 'project-1',
    state: 'running',
    color_slot: 5,
    route: ['lane-doing', 'lane-review'],
    waiting_for: [],
    lock_reason: '#14 is locked while Checkout hardening runs.',
    gate_target_id: null,
    ...overrides,
  };
}

function memberFixture(overrides: Partial<WorkflowMember> = {}): WorkflowMember {
  return {
    key: '#1',
    taskId: 'task-1',
    displayId: 1,
    projectId: 'project-1',
    board: null,
    title: 'A task',
    columnName: 'Doing',
    place: 'working',
    waitsFor: [],
    ...overrides,
  };
}

describe('normalizeWorkflowState', () => {
  it('keeps the four states the desktop sends', () => {
    expect(['running', 'paused', 'draft', 'done'].map(normalizeWorkflowState)).toEqual(['running', 'paused', 'draft', 'done']);
  });

  it('reads a state it does not know as running, the strictest reading for a move', () => {
    expect(normalizeWorkflowState('archived')).toBe('running');
    expect(normalizeWorkflowState('')).toBe('running');
  });

  it("words each state as the desktop's chip does", () => {
    expect(['running', 'paused', 'draft', 'done'].map((state) => workflowStateLabel(normalizeWorkflowState(state)))).toEqual([
      'Running',
      'Paused',
      'Not started',
      'Complete',
    ]);
  });
});

describe('workflowSlotNumber', () => {
  it('clamps to 1-6 and reads anything unreadable as 1, as workflowColor does', () => {
    expect(workflowSlotNumber(3)).toBe(3);
    expect(workflowSlotNumber(0)).toBe(1);
    expect(workflowSlotNumber(9)).toBe(6);
    expect(workflowSlotNumber(-2)).toBe(1);
    expect(workflowSlotNumber(Number.NaN)).toBe(1);
    expect(workflowSlotNumber(4.6)).toBe(5);
  });
});

describe('workflowCountLabel', () => {
  it('counts done of all once started, and tasks before', () => {
    expect(workflowCountLabel('running', 1, 6)).toBe('1 of 6');
    expect(workflowCountLabel('paused', 0, 4)).toBe('0 of 4');
    expect(workflowCountLabel('draft', 0, 5)).toBe('5 tasks');
    expect(workflowCountLabel('draft', 0, 1)).toBe('1 task');
  });
});

describe('workflowStripLabel', () => {
  it('names the workflow and says whether it is paused', () => {
    expect(workflowStripLabel(workflowFixture({ state: 'paused' }))).toEqual({ title: 'Checkout hardening', colorSlot: 5, paused: true });
    expect(workflowStripLabel(workflowFixture())?.paused).toBe(false);
    expect(workflowStripLabel(null)).toBeNull();
  });
});

describe('workflowAllowsMove (the desktop lock, mobile origin)', () => {
  const move = (workflow: BoardTaskWorkflowWire | null, toColumnId: string, toRole: string | null = null) =>
    workflowAllowsMove({ workflow, fromColumnId: 'lane-doing', toColumnId, toRole });

  it('lets an ordinary task go anywhere', () => {
    expect(move(null, 'lane-todo', 'todo')).toBe(true);
    expect(move(null, 'lane-review')).toBe(true);
  });

  it('always allows a move within the same column', () => {
    expect(move(workflowFixture(), 'lane-doing')).toBe(true);
  });

  it('refuses every other column for a running card outside a gate', () => {
    expect(move(workflowFixture(), 'lane-review')).toBe(false);
    expect(move(workflowFixture(), 'lane-done', 'done')).toBe(false);
    expect(move(workflowFixture(), 'lane-todo', 'todo')).toBe(false);
  });

  it('opens only the gate target to a running card in a human gate', () => {
    const gated = workflowFixture({ lock_reason: null, gate_target_id: 'lane-review' });
    expect(move(gated, 'lane-review')).toBe(true);
    expect(move(gated, 'lane-merge')).toBe(false);
    expect(move(gated, 'lane-todo', 'todo')).toBe(false);
  });

  it('lets a paused workflow card go anywhere but To Do', () => {
    const paused = workflowFixture({ state: 'paused', lock_reason: null });
    expect(move(paused, 'lane-review')).toBe(true);
    expect(move(paused, 'lane-done', 'done')).toBe(true);
    expect(move(paused, 'lane-todo', 'todo')).toBe(false);
  });

  it('lets a draft or finished workflow card go anywhere, To Do included', () => {
    expect(move(workflowFixture({ state: 'done', lock_reason: null }), 'lane-todo', 'todo')).toBe(true);
    expect(move(workflowFixture({ state: 'draft', lock_reason: null }), 'lane-todo', 'todo')).toBe(true);
  });

  it('treats an unknown state as running, so a new desktop state never unlocks a card', () => {
    expect(move(workflowFixture({ state: 'archived', lock_reason: null }), 'lane-review')).toBe(false);
  });
});

describe('workflowMoveTargetIds (the columns the Move sheet and the long-press hub offer)', () => {
  const columns = [
    boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0 }),
    boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1 }),
    boardColumnFixture({ id: 'lane-review', name: 'Review', role: null, position: 2 }),
    boardColumnFixture({ id: 'lane-merge', name: 'Merge', role: null, position: 3 }),
    boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 4 }),
  ];
  // The card sits in Doing in every case below.
  const targetIds = (workflow: BoardTaskWorkflowWire | null): string[] =>
    [...workflowMoveTargetIds(boardTaskFixture({ swimlane_id: 'lane-doing', workflow }), columns)].sort();

  it('offers an ordinary task every column but its own', () => {
    expect(targetIds(null)).toEqual(['lane-done', 'lane-merge', 'lane-review', 'lane-todo']);
  });

  it("offers a running card in a human gate only the gate's target", () => {
    expect(targetIds(workflowFixture({ lock_reason: null, gate_target_id: 'lane-review' }))).toEqual(['lane-review']);
  });

  it('offers a running card outside a gate nothing, so the hub can disable Move', () => {
    expect(targetIds(workflowFixture())).toEqual([]);
  });

  it('offers a paused workflow card every other column but To Do', () => {
    expect(targetIds(workflowFixture({ state: 'paused', lock_reason: null }))).toEqual(['lane-done', 'lane-merge', 'lane-review']);
  });

  it('offers a draft or finished workflow card every other column, To Do included', () => {
    for (const state of ['draft', 'done']) {
      expect(targetIds(workflowFixture({ state, lock_reason: null }))).toEqual(['lane-done', 'lane-merge', 'lane-review', 'lane-todo']);
    }
  });

  /**
   * Mutation seen failing: removing `if (column.id === task.swimlane_id) continue;`.
   * `workflowAllowsMove` accepts a move within the card's own column for every
   * state ("always allows a move within the same column"), so without that line
   * the card's own column joins every set above: "lane-doing" shows up in the
   * ordinary, paused, draft and done sets, and a running card outside a gate
   * is offered ['lane-doing'] instead of nothing.
   */
  it("never offers the task's own column, whatever its workflow", () => {
    const workflows: (BoardTaskWorkflowWire | null)[] = [
      null,
      workflowFixture(),
      workflowFixture({ lock_reason: null, gate_target_id: 'lane-review' }),
      workflowFixture({ state: 'paused', lock_reason: null }),
      workflowFixture({ state: 'draft', lock_reason: null }),
      workflowFixture({ state: 'done', lock_reason: null }),
    ];
    for (const workflow of workflows) {
      expect(targetIds(workflow)).not.toContain('lane-doing');
    }
  });
});

describe('workflowBlocksArchive', () => {
  it('refuses Archive for every workflow task in every state, as sendAwayRefusal does', () => {
    for (const state of ['running', 'paused', 'draft', 'done']) expect(workflowBlocksArchive(workflowFixture({ state }))).toBe(true);
    expect(workflowBlocksArchive(null)).toBe(false);
    expect(workflowBlocksArchive(undefined)).toBe(false);
  });
});

describe('workflowWaitingFooter (the desktop waitingLabel)', () => {
  it('names one blocker, counts several, and lets a blocker win over the pause', () => {
    expect(workflowWaitingFooter(workflowFixture({ waiting_for: ['#14'] }), 'todo')).toEqual({ label: 'Blocked by #14...', paused: false });
    expect(workflowWaitingFooter(workflowFixture({ waiting_for: ['#14', '#15'] }), 'todo')).toEqual({ label: 'Blocked by 2 tasks...', paused: false });
    expect(workflowWaitingFooter(workflowFixture({ state: 'paused', waiting_for: ['#14'] }), 'todo')).toEqual({ label: 'Blocked by #14...', paused: false });
  });

  it('says Paused or Queued when nothing blocks it', () => {
    expect(workflowWaitingFooter(workflowFixture({ state: 'paused' }), 'todo')).toEqual({ label: 'Paused', paused: true });
    expect(workflowWaitingFooter(workflowFixture(), 'todo')).toEqual({ label: 'Queued...', paused: false });
  });

  it('says nothing outside To Do, for a draft or done workflow, or an ordinary task', () => {
    expect(workflowWaitingFooter(workflowFixture(), null)).toBeNull();
    expect(workflowWaitingFooter(workflowFixture({ state: 'done' }), 'todo')).toBeNull();
    expect(workflowWaitingFooter(workflowFixture({ state: 'draft' }), 'todo')).toBeNull();
    expect(workflowWaitingFooter(null, 'todo')).toBeNull();
  });
});

describe('parseWorkflowList', () => {
  it('reads the list and skips rows it cannot', () => {
    const value: JsonValue = [
      { id: 'workflow-1', title: 'Checkout hardening', state: 'running' },
      { id: 'workflow-2', title: 'Pricing', state: 'mystery' },
      { title: 'No id' },
      'not a row',
    ];
    expect(parseWorkflowList(value)).toEqual([
      { id: 'workflow-1', title: 'Checkout hardening', state: 'running' },
      { id: 'workflow-2', title: 'Pricing', state: 'running' },
    ]);
  });

  it('reads anything but an array as no workflows', () => {
    expect(parseWorkflowList({ note: 'list_workflows completed.' })).toEqual([]);
  });
});

describe('parseWorkflowDetail', () => {
  it("reads the workflow, its home and its tasks, skipping a task it cannot read", () => {
    const value: JsonValue = {
      workflow: { id: 'workflow-1', title: 'Checkout hardening', state: 'paused', color_slot: 5, brief: 'unused' },
      homeProjectId: 'project-home',
      tasks: [
        { key: '#13', taskId: 'task-13', displayId: 13, projectId: 'project-home', board: null, title: 'Done one', column: 'Done', place: 'done', route: [], waitsFor: [] },
        { key: '#7', taskId: 'task-7', displayId: 7, projectId: 'project-other', board: 'storefront', title: 'Elsewhere', column: 'Doing', place: 'working', route: ['Doing'], waitsFor: ['#13'] },
        { key: '#8', title: 'No project' },
      ],
    };
    const detail = parseWorkflowDetail(value, 'project-asked');
    expect(detail?.state).toBe('paused');
    expect(detail?.homeProjectId).toBe('project-home');
    expect(detail?.members.map((member) => member.key)).toEqual(['#13', '#7']);
    expect(detail?.members[1]?.board).toBe('storefront');
    expect(detail ? workflowDoneCount(detail) : null).toBe(1);
  });

  it('falls back to the asked project and slot 1, and is null without a readable workflow', () => {
    const detail = parseWorkflowDetail({ workflow: { id: 'workflow-1', title: 'T' }, tasks: [] }, 'project-asked');
    expect(detail?.homeProjectId).toBe('project-asked');
    expect(detail?.colorSlot).toBe(1);
    expect(detail?.state).toBe('running');
    expect(parseWorkflowDetail({ tasks: [] }, 'project-asked')).toBeNull();
    expect(parseWorkflowDetail({ note: 'get_workflow completed.' }, 'project-asked')).toBeNull();
  });
});

describe('workflowRunDepths (layers by longest path)', () => {
  it('puts each task one past the furthest task it waits for', () => {
    const members = [
      memberFixture({ key: '#13', place: 'done' }),
      memberFixture({ key: '#14', waitsFor: ['#13'] }),
      memberFixture({ key: '#15', waitsFor: ['#13'] }),
      memberFixture({ key: '#16', waitsFor: ['#14'] }),
      memberFixture({ key: '#17', waitsFor: ['#14', '#15', '#16'] }),
      memberFixture({ key: '#18' }),
    ];
    const depths = workflowRunDepths(members);
    expect(members.map((member) => depths.get(member))).toEqual([0, 1, 1, 2, 3, 0]);
  });

  it('matches a task on another board by its board-named key, and ignores a key it cannot find', () => {
    const other = memberFixture({ key: '#7', board: 'storefront', projectId: 'project-other' });
    const waiting = memberFixture({ key: '#9', waitsFor: ['#7 on "storefront"', 'a task on "gone" that could not be read'] });
    const depths = workflowRunDepths([other, waiting]);
    expect(depths.get(waiting)).toBe(1);
  });

  it('does not loop on a cycle', () => {
    const first = memberFixture({ key: '#1', waitsFor: ['#2'] });
    const second = memberFixture({ key: '#2', waitsFor: ['#1'] });
    const depths = workflowRunDepths([first, second]);
    expect(depths.size).toBe(2);
  });
});

describe('groupWorkflowMembers (design V6)', () => {
  const columns = [
    boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0 }),
    boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1 }),
    boardColumnFixture({ id: 'lane-review', name: 'Review', role: null, position: 2 }),
    boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 3 }),
  ];

  function detailOf(members: WorkflowMember[], state: WorkflowDetail['state'] = 'running'): WorkflowDetail {
    return { id: 'workflow-1', title: 'Checkout hardening', state, colorSlot: 5, homeProjectId: 'project-1', members };
  }

  it('groups by board column in board order, only the columns holding a task, Done last', () => {
    const members = [
      memberFixture({ key: '#13', taskId: 'task-13', displayId: 13, place: 'done', columnName: 'Done' }),
      memberFixture({ key: '#15', taskId: 'task-15', displayId: 15, columnName: 'Review' }),
      memberFixture({ key: '#16', taskId: 'task-16', displayId: 16, place: 'todo', columnName: 'To Do', waitsFor: ['#15'] }),
      memberFixture({ key: '#18', taskId: 'task-18', displayId: 18, place: 'todo', columnName: 'To Do' }),
    ];
    const sections = groupWorkflowMembers({ detail: detailOf(members), columnsByProjectId: { 'project-1': columns }, rowFor: () => null });
    expect(sections.map((section) => section.name)).toEqual(['To Do', 'Review', 'Done']);
    // Inside To Do, the task that can start next comes first.
    expect(sections[0]?.members.map((member) => member.key)).toEqual(['#18', '#16']);
  });

  it("takes a loaded task's column from its live row over the workflow's older read", () => {
    const members = [memberFixture({ key: '#15', taskId: 'task-15', columnName: 'Doing' })];
    const liveRow = boardTaskFixture({ id: 'task-15', swimlane_id: 'lane-review' });
    const sections = groupWorkflowMembers({
      detail: detailOf(members),
      columnsByProjectId: { 'project-1': columns },
      rowFor: (member) => (member.taskId === 'task-15' ? liveRow : null),
    });
    expect(sections.map((section) => section.name)).toEqual(['Review']);
  });

  it("puts a planned task in To Do and a task on another board's To Do in the same section", () => {
    const otherColumns = [boardColumnFixture({ id: 'other-backlog', name: 'Backlog', role: 'todo', position: 0 })];
    const members = [
      memberFixture({ key: 'plan-1', taskId: null, displayId: null, place: 'planned', columnName: 'To Do (created at Start)' }),
      memberFixture({ key: '#3', taskId: 'other-3', projectId: 'project-other', board: 'storefront', place: 'todo', columnName: 'Backlog' }),
    ];
    const sections = groupWorkflowMembers({
      detail: detailOf(members, 'draft'),
      columnsByProjectId: { 'project-1': columns, 'project-other': otherColumns },
      rowFor: () => null,
    });
    expect(sections.map((section) => section.name)).toEqual(['To Do']);
    expect(sections[0]?.members).toHaveLength(2);
  });
});

describe('workflowTally', () => {
  it('counts each activity', () => {
    expect(workflowTally(['idle', 'active', 'waiting', 'waiting', 'done'])).toEqual({ idle: 1, active: 1, waiting: 2, done: 1 });
  });
});
