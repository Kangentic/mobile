import { isRecord, type BoardColumnWire, type BoardTaskWire, type JsonValue } from '@kangentic/protocol';
import { isDoneRole, isTodoRole } from '@/state/boardStore';
import { normalizeWorkflowState, type WorkflowStateName } from './workflowState';

/**
 * The workflow view's data: what the desktop's `list_workflows` and
 * `get_workflow` board tools return, read into the view's own shapes.
 *
 * The protocol types every board tool's `result` as `JsonValue` on purpose (the
 * bridge forwards the desktop command's data as it is), so these readers narrow
 * JSON rather than mirror a protocol type. They are lenient the way
 * `parseBoardTaskWorkflowWire` is: a row they cannot read costs that row, never
 * the whole view, and they read only the fields the phone draws.
 */

/** Where a workflow task is, in the desktop's words (`WorkflowTaskView.place`). */
export type WorkflowTaskPlace = 'planned' | 'todo' | 'working' | 'done';

/** One of a project's unfinished workflows, as `list_workflows` lists it. */
export interface WorkflowListEntry {
  id: string;
  title: string;
  state: WorkflowStateName;
}

/** One task of a workflow, as `get_workflow` describes it. */
export interface WorkflowMember {
  /** "#413"; a planned task's key in a workflow that has not started. */
  key: string;
  /** Null for a planned task, which has no board row yet. */
  taskId: string | null;
  displayId: number | null;
  projectId: string;
  /** Its board's name when that is not the workflow's home board, else null. */
  board: string | null;
  title: string;
  /** Its column's name on its own board. */
  columnName: string;
  place: WorkflowTaskPlace;
  /** Keys of the tasks it waits for, finished ones included. */
  waitsFor: string[];
}

export interface WorkflowDetail {
  id: string;
  title: string;
  state: WorkflowStateName;
  colorSlot: number;
  homeProjectId: string;
  members: WorkflowMember[];
}

function isWorkflowTaskPlace(value: unknown): value is WorkflowTaskPlace {
  return value === 'planned' || value === 'todo' || value === 'working' || value === 'done';
}

function stringsOf(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** `list_workflows`'s result: `[{ id, title, state }]`, or `[]`. Anything else reads as none. */
export function parseWorkflowList(value: JsonValue): WorkflowListEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: WorkflowListEntry[] = [];
  for (const row of value) {
    if (!isRecord(row) || typeof row.id !== 'string' || typeof row.title !== 'string') continue;
    entries.push({ id: row.id, title: row.title, state: normalizeWorkflowState(typeof row.state === 'string' ? row.state : '') });
  }
  return entries;
}

function parseWorkflowMember(value: JsonValue): WorkflowMember | null {
  if (!isRecord(value)) return null;
  if (typeof value.key !== 'string' || typeof value.title !== 'string' || typeof value.projectId !== 'string') return null;
  return {
    key: value.key,
    taskId: typeof value.taskId === 'string' ? value.taskId : null,
    displayId: typeof value.displayId === 'number' ? value.displayId : null,
    projectId: value.projectId,
    board: typeof value.board === 'string' ? value.board : null,
    title: value.title,
    columnName: typeof value.column === 'string' ? value.column : '',
    place: isWorkflowTaskPlace(value.place) ? value.place : 'working',
    waitsFor: stringsOf(value.waitsFor),
  };
}

/**
 * `get_workflow`'s result: `{ workflow, homeProjectId, tasks }`. Null when the
 * workflow itself cannot be read. `homeProjectId` falls back to the project the
 * phone asked, which is the home it was asked of.
 */
export function parseWorkflowDetail(value: JsonValue, requestedHomeProjectId: string): WorkflowDetail | null {
  if (!isRecord(value) || !isRecord(value.workflow)) return null;
  const workflow = value.workflow;
  if (typeof workflow.id !== 'string' || typeof workflow.title !== 'string') return null;
  const members = Array.isArray(value.tasks)
    ? value.tasks.map(parseWorkflowMember).filter((member): member is WorkflowMember => member !== null)
    : [];
  return {
    id: workflow.id,
    title: workflow.title,
    state: normalizeWorkflowState(typeof workflow.state === 'string' ? workflow.state : ''),
    colorSlot: typeof workflow.color_slot === 'number' ? workflow.color_slot : 1,
    homeProjectId: typeof value.homeProjectId === 'string' ? value.homeProjectId : requestedHomeProjectId,
    members,
  };
}

/** How many of a workflow's tasks are done. */
export function workflowDoneCount(detail: WorkflowDetail): number {
  return detail.members.filter((member) => member.place === 'done').length;
}

/**
 * The name another task's `waitsFor` uses for this one: its key on the home
 * board, and its key with its board on any other (`#7 on "Board"`), since task
 * numbers count per board. A planned task is linked by its plan key alone.
 */
function linkKeyOf(member: WorkflowMember): string {
  if (member.place === 'planned' || member.board === null) return member.key;
  return `${member.key} on "${member.board}"`;
}

/**
 * How far down its chain each task is: zero for a task that waits for nothing,
 * else one more than the furthest task it waits for. This is the desktop
 * canvas's layering (`workflow-layout.ts`, layers by longest path), used here
 * only to order the tasks inside a column so the one that can start next comes
 * first. A key that names no task of the workflow is ignored, and a cycle (the
 * desktop refuses one) reads as no further depth rather than looping.
 */
export function workflowRunDepths(members: readonly WorkflowMember[]): Map<WorkflowMember, number> {
  const memberByLinkKey = new Map<string, WorkflowMember>();
  for (const member of members) memberByLinkKey.set(linkKeyOf(member), member);
  const depthByMember = new Map<WorkflowMember, number>();
  const visiting = new Set<WorkflowMember>();
  const depthOf = (member: WorkflowMember): number => {
    const known = depthByMember.get(member);
    if (known !== undefined) return known;
    if (visiting.has(member)) return 0;
    visiting.add(member);
    let depth = 0;
    for (const blockerKey of member.waitsFor) {
      const blocker = memberByLinkKey.get(blockerKey);
      if (blocker) depth = Math.max(depth, depthOf(blocker) + 1);
    }
    visiting.delete(member);
    depthByMember.set(member, depth);
    return depth;
  };
  for (const member of members) depthOf(member);
  return depthByMember;
}

/** One section of the workflow view: a board column, holding this workflow's tasks in it. */
export interface WorkflowSection {
  key: string;
  name: string;
  /** The column the heading draws its glyph and color from; null when no board knows it. */
  column: BoardColumnWire | null;
  members: WorkflowMember[];
}

export interface WorkflowGroupingInput {
  detail: WorkflowDetail;
  /** Each loaded project's visible columns, in board order (`selectColumnsOrdered`). */
  columnsByProjectId: Readonly<Record<string, readonly BoardColumnWire[]>>;
  /** A task's live board row, when its board is loaded; it outranks `get_workflow`'s older read. */
  rowFor: (member: WorkflowMember) => BoardTaskWire | null;
}

const TODO_SECTION_KEY = 'role:todo';
/** The Done section's key, the one section whose tasks are finished. */
export const WORKFLOW_DONE_SECTION_KEY = 'role:done';

/**
 * The workflow view's sections (design V6, signed off 2026-10-17): the board's
 * columns in board order, holding only this workflow's tasks, so the flow reads
 * top to bottom the way the board reads left to right. Only a column holding
 * one of its tasks appears.
 *
 * - A task's column comes from its live row when its board is loaded, else
 *   from `get_workflow`. Done (or archived) and To Do are matched by role, so
 *   tasks on several boards share one To Do and one Done; a working column is
 *   matched by name across boards.
 * - A planned task (a workflow not started) sits in To Do.
 * - Sections follow the home board's column order; a column only another board
 *   has comes after them, and Done is always last.
 * - Inside a section, tasks go by `workflowRunDepths`, then by number.
 */
export function groupWorkflowMembers(input: WorkflowGroupingInput): WorkflowSection[] {
  const { detail, columnsByProjectId, rowFor } = input;
  const homeColumns = columnsByProjectId[detail.homeProjectId] ?? [];
  const depths = workflowRunDepths(detail.members);
  const sectionsByKey = new Map<string, WorkflowSection>();
  const orderByKey = new Map<string, number>();
  let unknownOrder = homeColumns.length;

  const roleColumn = (role: 'todo' | 'done', memberColumns: readonly BoardColumnWire[]): BoardColumnWire | null => {
    const matches = (column: BoardColumnWire) => (role === 'todo' ? isTodoRole(column.role) : isDoneRole(column.role));
    return homeColumns.find(matches) ?? memberColumns.find(matches) ?? null;
  };

  for (const member of detail.members) {
    const memberColumns = columnsByProjectId[member.projectId] ?? [];
    const row = rowFor(member);
    const liveColumn = row ? (memberColumns.find((column) => column.id === row.swimlane_id) ?? null) : null;
    const isDone = row
      ? row.archived_at !== null || (liveColumn !== null && isDoneRole(liveColumn.role))
      : member.place === 'done';
    const isTodo =
      !isDone && (liveColumn !== null ? isTodoRole(liveColumn.role) : member.place === 'todo' || member.place === 'planned');

    let key: string;
    let column: BoardColumnWire | null;
    let fallbackName: string;
    if (isDone) {
      key = WORKFLOW_DONE_SECTION_KEY;
      column = roleColumn('done', memberColumns);
      fallbackName = 'Done';
    } else if (isTodo) {
      key = TODO_SECTION_KEY;
      column = roleColumn('todo', memberColumns);
      fallbackName = 'To Do';
    } else {
      const name = liveColumn?.name ?? member.columnName;
      key = `column:${name}`;
      column = homeColumns.find((candidate) => candidate.name === name) ?? liveColumn ?? memberColumns.find((candidate) => candidate.name === name) ?? null;
      fallbackName = name;
    }

    let section = sectionsByKey.get(key);
    if (!section) {
      const homeIndex = column ? homeColumns.findIndex((candidate) => candidate.id === column.id) : -1;
      orderByKey.set(key, key === WORKFLOW_DONE_SECTION_KEY ? Number.MAX_SAFE_INTEGER : homeIndex !== -1 ? homeIndex : unknownOrder++);
      section = { key, name: column?.name ?? fallbackName, column, members: [] };
      sectionsByKey.set(key, section);
    }
    section.members.push(member);
  }

  return [...sectionsByKey.values()]
    .sort((first, second) => (orderByKey.get(first.key) ?? 0) - (orderByKey.get(second.key) ?? 0))
    .map((section) => ({
      ...section,
      members: [...section.members].sort((first, second) => {
        const depthDifference = (depths.get(first) ?? 0) - (depths.get(second) ?? 0);
        if (depthDifference !== 0) return depthDifference;
        const firstNumber = first.displayId ?? Number.MAX_SAFE_INTEGER;
        const secondNumber = second.displayId ?? Number.MAX_SAFE_INTEGER;
        if (firstNumber !== secondNumber) return firstNumber - secondNumber;
        return first.title.localeCompare(second.title);
      }),
    }));
}

/** What each task of a workflow is doing, for the view's counts. */
export type WorkflowMemberActivity = 'idle' | 'active' | 'waiting' | 'done';

export function workflowTally(activities: readonly WorkflowMemberActivity[]): Record<WorkflowMemberActivity, number> {
  const tally: Record<WorkflowMemberActivity, number> = { idle: 0, active: 0, waiting: 0, done: 0 };
  for (const activity of activities) tally[activity] += 1;
  return tally;
}
