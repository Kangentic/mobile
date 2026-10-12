import {
  parseCommandTerminalStartResponsePayload,
  parsePauseSessionResponsePayload,
  parseReadBoardResponsePayload,
  parseReadDiffResponsePayload,
  parseReadStreamResponsePayload,
  parseStartSessionResponsePayload,
  parseTranscriptWindowResponsePayload,
  type AnswerPermissionPromptRequestPayload,
  type AnswerPermissionPromptResponsePayload,
  type BoardToolReadName,
  type BoardToolWriteName,
  type CapabilityErrorCode,
  type CapabilityResponseMessage,
  type CapabilityVerb,
  type CommandTerminalRequestPayload,
  type CommandTerminalStartResponsePayload,
  type DiffFileContentWire,
  type DiffFileListWire,
  type InteractiveTerminalRequestPayload,
  type JsonValue,
  type MoveTaskRequestPayload,
  type MoveTaskResponsePayload,
  type PauseSessionRequestPayload,
  type PauseSessionResponsePayload,
  type ReadBoardArchivedResponsePayload,
  type ReadBoardProjectListResponsePayload,
  type ReadBoardSnapshotResponsePayload,
  type ReadBoardView,
  type ReadDiffScope,
  type ReadStreamRequestPayload,
  type ReadStreamResponsePayload,
  type RegisterPushRequestPayload,
  type RegisterPushResponsePayload,
  type SendUserMessageRequestPayload,
  type SendUserMessageResponsePayload,
  type StartSessionRequestPayload,
  type StartSessionResponsePayload,
  type TranscriptWindowResponsePayload,
  isRecord,
} from '@kangentic/protocol';
import type { CapabilityClient } from './capabilityClient';

/**
 * Envelope-boundary cast for an already-shape-checked request payload:
 * interfaces have no implicit index signature, so a typed payload does not
 * assign to JsonValue structurally even though it always is one (the same
 * cast the desktop's wire-mappers centralize as toWireJson).
 */
function asRequestJson(payload: unknown): JsonValue {
  return payload as JsonValue;
}

/**
 * `move-task` gets its own, far longer timeout: it is the one verb whose
 * answer waits on real work rather than a lookup.
 *
 * A current desktop answers when the board row commits, which is fast. An
 * older one awaits the whole of handleTaskMove - the PTY suspend, the worktree
 * removal on a Done move, the respawn on an auto-spawn column. Measured across
 * a week of desktop IPC logs, 9% of task:move calls ran past 10s and the
 * slowest took 24.4s, so the shared default turned moves the desktop had
 * already completed into "Move failed", with the card rolled back underneath
 * the user. 45s clears that measured tail with headroom while still failing
 * eventually rather than hanging.
 */
const MOVE_TASK_TIMEOUT_MS = 45_000;

/**
 * A `command-terminal` start's own timeout. The desktop answers once the
 * terminal's session exists, which is after the git steps a New terminal runs
 * on the project folder: a phone start runs them unattended, with a 5 s abort
 * on the fetch inside one 6 s budget for the whole git phase, and then spawns
 * (read from the desktop's command-terminal handler and its bridge doc, not
 * measured from the phone). That budget alone is most of the shared 10 s
 * default before a relay round trip is counted, so a slow start would read as
 * a failure while the terminal was in fact starting. 30 s clears it with room,
 * and a timeout still re-reads the board (see startCommandTerminal), because
 * the terminal may well be running.
 */
export const COMMAND_TERMINAL_START_TIMEOUT_MS = 30_000;

/** A capability request the desktop answered with ok:false (or whose response payload failed its parse guard). */
export class CapabilityError extends Error {
  readonly verb: CapabilityVerb;
  /**
   * The refusal's stable key, when the desktop sent one: `unsupported-verb`
   * (protocol 0.15.0) or `response-too-large` (0.19.0). Branch on this, never
   * on `message`, which is the desktop's display text. Absent for a refusal
   * with no key and for a response that failed its parse guard.
   */
  readonly code?: CapabilityErrorCode;

  constructor(verb: CapabilityVerb, message: string, code?: CapabilityErrorCode) {
    super(message);
    this.name = 'CapabilityError';
    this.verb = verb;
    this.code = code;
  }
}

export interface ReadDiffFileListInput {
  /**
   * The task whose worktree to diff, or null for the project folder against
   * the project's default base branch (protocol 0.20.0, a Command Terminal's
   * Changes). Null OMITS the field on the wire, which is how the desktop tells
   * the two apart; it never sends a placeholder id.
   */
  taskId: string | null;
  projectId: string;
  scope?: ReadDiffScope;
}

export interface ReadDiffFileContentInput extends ReadDiffFileListInput {
  filePath: string;
}

/**
 * Typed per-verb methods over CapabilityClient's raw request/response
 * correlation - the only API stores and actions call for one-shots. Every
 * method builds the verb's typed request payload, throws CapabilityError
 * on ok:false, and runs the protocol package's response parser before
 * returning, so nothing above this file ever handles a raw JsonValue.
 *
 * Live feed events are deliberately NOT here - they arrive unsolicited as
 * EventMessages and are FeedRouter's job; a subscription verb's response
 * here is only its initial snapshot.
 */
export class VerbClient {
  private readonly capabilities: CapabilityClient;

  constructor(capabilities: CapabilityClient) {
    this.capabilities = capabilities;
  }

  /**
   * `terminal: false` subscribes to everything the session list renders -
   * activity, usage, permission, transcript - without the live PTY bytes.
   * The feed discards those bytes anyway (see storeFeed's terminal handler),
   * and on a live board they measured ~13MB an hour with no terminal open.
   * A pre-0.8.0 desktop ignores the flag and keeps sending, which is exactly
   * the behaviour we had before.
   */
  async readStreamSubscribe(sessionId: string, options: { terminal?: boolean } = {}): Promise<ReadStreamResponsePayload> {
    const payload: ReadStreamRequestPayload = {
      sessionId,
      action: 'subscribe',
      ...(options.terminal !== undefined ? { terminal: options.terminal } : {}),
    };
    const response = await this.requireOk('read-stream', asRequestJson(payload));
    return this.parsePayload('read-stream', response, parseReadStreamResponsePayload);
  }

  async readStreamUnsubscribe(sessionId: string): Promise<void> {
    const payload: ReadStreamRequestPayload = { sessionId, action: 'unsubscribe' };
    await this.requireOk('read-stream', asRequestJson(payload));
  }

  /**
   * One-shot windowed transcript read: the newest `limit` entries strictly
   * before `beforeIndex` (or the tail when omitted). The desktop may
   * return fewer entries than asked to keep the frame small - page again
   * from the returned startIndex. Live updates ride TranscriptEvent deltas.
   */
  async readTranscriptWindow(sessionId: string, options: { beforeIndex?: number; limit?: number } = {}): Promise<TranscriptWindowResponsePayload> {
    const payload: ReadStreamRequestPayload = {
      sessionId,
      action: 'transcript-window',
      ...(options.beforeIndex !== undefined ? { beforeIndex: options.beforeIndex } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    };
    const response = await this.requireOk('read-stream', asRequestJson(payload));
    return this.parsePayload('read-stream', response, parseTranscriptWindowResponsePayload);
  }

  async readProjectList(): Promise<ReadBoardProjectListResponsePayload> {
    const response = await this.requireOk('read-board', {});
    const parsed = this.parsePayload('read-board', response, parseReadBoardResponsePayload);
    if (!('projects' in parsed)) throw new CapabilityError('read-board', 'Expected a project list, received a board snapshot');
    return parsed;
  }

  /**
   * `view` picks the projection: 'sessions' for the feed's cross-project
   * watch, 'full' for the one board the user has open. A pre-0.9.0 desktop
   * ignores it and answers with a full board carrying no `view` echo.
   */
  async readBoardSubscribe(projectId: string, options: { view: ReadBoardView }): Promise<ReadBoardSnapshotResponsePayload> {
    const response = await this.requireOk('read-board', { projectId, action: 'subscribe', view: options.view });
    const parsed = this.parsePayload('read-board', response, parseReadBoardResponsePayload);
    // Narrowed against BOTH other shapes. A snapshot is the only one carrying
    // `columns`, so testing for that identifies it positively rather than by
    // elimination - which is what stops the next response shape added to this
    // union from silently passing through here as a snapshot.
    if (!('columns' in parsed)) {
      throw new CapabilityError('read-board', 'Expected a board snapshot, received a different read-board response');
    }
    return parsed;
  }

  async readBoardUnsubscribe(projectId: string): Promise<void> {
    await this.requireOk('read-board', { projectId, action: 'unsubscribe' });
  }

  /**
   * One page of a project's COMPLETED tasks, newest first, with each one's
   * lifetime session summary (protocol 0.10.0).
   *
   * A one-shot read, not a subscription: neither board projection carries
   * archived tasks, and folding them into the snapshot would re-send an
   * ever-growing list on every board change.
   */
  async readBoardArchived(
    projectId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<ReadBoardArchivedResponsePayload> {
    const response = await this.requireOk('read-board', {
      projectId,
      action: 'archived',
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
    });
    const parsed = this.parsePayload('read-board', response, parseReadBoardResponsePayload);
    // A pre-0.10.0 desktop does not know the 'archived' action. Its parser
    // rejects the request outright, so this narrowing only has to catch the
    // shapes a 0.10.0 desktop can legitimately return.
    if (!('archivedTasks' in parsed)) {
      throw new CapabilityError('read-board', 'Expected an archived page, received a different read-board response');
    }
    return parsed;
  }

  /** Fetches the diff file list AND (desktop-side) subscribes the task's diff watch; DiffEvents follow until readDiffUnsubscribe. */
  async readDiffFileList(input: ReadDiffFileListInput): Promise<DiffFileListWire> {
    const response = await this.requireOk('read-diff', {
      ...(input.taskId !== null ? { taskId: input.taskId } : {}),
      projectId: input.projectId,
      ...(input.scope ? { scope: input.scope } : {}),
    });
    const parsed = this.parsePayload('read-diff', response, parseReadDiffResponsePayload);
    if (!('files' in parsed)) throw new CapabilityError('read-diff', 'Expected a diff file list, received file content');
    return parsed;
  }

  /** One-shot single-file content fetch; never affects the diff watch. */
  async readDiffFileContent(input: ReadDiffFileContentInput): Promise<DiffFileContentWire> {
    const response = await this.requireOk('read-diff', {
      ...(input.taskId !== null ? { taskId: input.taskId } : {}),
      projectId: input.projectId,
      filePath: input.filePath,
      ...(input.scope ? { scope: input.scope } : {}),
    });
    const parsed = this.parsePayload('read-diff', response, parseReadDiffResponsePayload);
    if ('files' in parsed) throw new CapabilityError('read-diff', 'Expected file content, received a diff file list');
    return parsed;
  }

  async readDiffUnsubscribe(input: { taskId: string | null; projectId: string }): Promise<void> {
    await this.requireOk('read-diff', {
      ...(input.taskId !== null ? { taskId: input.taskId } : {}),
      projectId: input.projectId,
      action: 'unsubscribe',
    });
  }

  async sendUserMessage(sessionId: string, text: string): Promise<SendUserMessageResponsePayload> {
    const payload: SendUserMessageRequestPayload = { sessionId, text };
    const response = await this.requireOk('send-user-message', asRequestJson(payload));
    return this.parsePayload('send-user-message', response, (value) => {
      if (!isRecord(value) || typeof value.delivered !== 'boolean') throw new Error('send-user-message response is missing "delivered"');
      return { delivered: value.delivered };
    });
  }

  async moveTask(input: MoveTaskRequestPayload): Promise<MoveTaskResponsePayload> {
    const response = await this.requireOk('move-task', asRequestJson(input), { timeoutMs: MOVE_TASK_TIMEOUT_MS });
    return this.parsePayload('move-task', response, (value) => {
      if (!isRecord(value) || typeof value.ok !== 'boolean') throw new Error('move-task response is missing "ok"');
      return { ok: value.ok };
    });
  }

  /**
   * Starts or resumes a task's session in the column it already sits in. The
   * desktop answers when it ACCEPTS the start, not when the agent is up:
   * `starting` means the successor will arrive as the usual board and stream
   * events; `live` means a session is already live (queued counts), so no event
   * is coming. A failure after acceptance sends nothing back, so a caller owns
   * its own wait bound.
   */
  async startSession(input: StartSessionRequestPayload): Promise<StartSessionResponsePayload> {
    const response = await this.requireOk('start-session', asRequestJson(input));
    return this.parsePayload('start-session', response, parseStartSessionResponsePayload);
  }

  /**
   * Pauses a task's live session the way the desktop's Pause button does
   * (protocol 0.18.0). Keyed by task: the desktop resolves the live session
   * itself. It answers when the pause is ACCEPTED (recorded), while the agent's
   * shutdown runs on behind it; the paused row then arrives as the usual board
   * event. A refusal (no live session, an unknown project) is a CapabilityError.
   */
  async pauseSession(input: PauseSessionRequestPayload): Promise<PauseSessionResponsePayload> {
    const response = await this.requireOk('pause-session', asRequestJson(input));
    return this.parsePayload('pause-session', response, parsePauseSessionResponsePayload);
  }

  /**
   * Starts a Command Terminal in a project (protocol 0.20.0): the agent the
   * desktop's own New terminal runs at the project root, on the default branch,
   * with no task. The phone names only the project. Answered once the session
   * exists, before the agent has drawn anything. A refusal is a CapabilityError
   * carrying its typed `code` (`command-terminal-limit`, `unknown-project`,
   * `agent-unavailable`, `command-terminal-start-failed`, or `unsupported-verb`
   * from a desktop that predates the verb).
   */
  async startCommandTerminal(projectId: string): Promise<CommandTerminalStartResponsePayload> {
    const payload: CommandTerminalRequestPayload = { action: 'start', projectId };
    const response = await this.requireOk('command-terminal', asRequestJson(payload), { timeoutMs: COMMAND_TERMINAL_START_TIMEOUT_MS });
    return this.parsePayload('command-terminal', response, parseCommandTerminalStartResponsePayload);
  }

  /**
   * Stops a Command Terminal by its session (protocol 0.20.0), the desktop
   * Stop's own call. Answered once the terminal has ended. The desktop refuses
   * any session that is not a Command Terminal (`not-command-terminal`), and
   * answers `unknown-session` for one that already ended, which the caller
   * treats as stopped.
   */
  async stopCommandTerminal(sessionId: string): Promise<void> {
    const payload: CommandTerminalRequestPayload = { action: 'stop', sessionId };
    const response = await this.requireOk('command-terminal', asRequestJson(payload));
    this.parsePayload('command-terminal', response, (value) => {
      if (!isRecord(value) || value.ok !== true) throw new Error('command-terminal stop response is missing "ok"');
      return value;
    });
  }

  async answerPermissionPrompt(input: AnswerPermissionPromptRequestPayload): Promise<AnswerPermissionPromptResponsePayload> {
    const response = await this.requireOk('answer-permission-prompt', asRequestJson(input));
    return this.parsePayload('answer-permission-prompt', response, (value) => {
      if (!isRecord(value) || typeof value.answered !== 'boolean') throw new Error('answer-permission-prompt response is missing "answered"');
      return { answered: value.answered };
    });
  }

  /**
   * The one thing the phone writes to the terminal: raw keystrokes. The phone
   * is a faithful mirror and deliberately never RESIZES the desktop PTY (the
   * protocol's resize/release actions exist for the desktop, not this client) -
   * a shared session must not be reshaped by the phone.
   */
  async writeInteractiveTerminal(sessionId: string, data: string): Promise<{ written: boolean }> {
    const payload: InteractiveTerminalRequestPayload = { sessionId, action: 'write', data };
    const response = await this.requireOk('interactive-terminal', asRequestJson(payload));
    return this.parsePayload('interactive-terminal', response, (value) => {
      if (!isRecord(value) || typeof value.written !== 'boolean') throw new Error('interactive-terminal response is missing "written"');
      return { written: value.written };
    });
  }

  /** Registers (or unregisters) this device for E2E-encrypted push; see src/notifications/pushRegistration.ts. */
  async registerPush(payload: RegisterPushRequestPayload): Promise<RegisterPushResponsePayload> {
    const response = await this.requireOk('register-push', asRequestJson(payload));
    return this.parsePayload('register-push', response, (value) => {
      if (!isRecord(value) || typeof value.registered !== 'boolean') throw new Error('register-push response is missing "registered"');
      return { registered: value.registered };
    });
  }

  async boardToolRead(tool: BoardToolReadName, params: JsonValue): Promise<JsonValue> {
    const response = await this.requireOk('board-tool-read', { tool, params });
    return this.parsePayload('board-tool-read', response, (value) => {
      if (!isRecord(value) || !('result' in value)) throw new Error('board-tool response is missing "result"');
      return value.result;
    });
  }

  async boardToolWrite(tool: BoardToolWriteName, params: JsonValue): Promise<JsonValue> {
    const response = await this.requireOk('board-tool-write', { tool, params });
    return this.parsePayload('board-tool-write', response, (value) => {
      if (!isRecord(value) || !('result' in value)) throw new Error('board-tool response is missing "result"');
      return value.result;
    });
  }

  private async requireOk(
    verb: CapabilityVerb,
    payload: JsonValue,
    options?: { timeoutMs?: number },
  ): Promise<CapabilityResponseMessage> {
    const response = await this.capabilities.request(verb, payload, options);
    if (!response.ok) throw new CapabilityError(verb, response.error ?? `The desktop rejected the ${verb} request`, response.code);
    return response;
  }

  private parsePayload<Parsed>(
    verb: CapabilityVerb,
    response: CapabilityResponseMessage,
    parse: (payload: JsonValue) => Parsed,
  ): Parsed {
    if (response.payload === undefined) throw new CapabilityError(verb, `The ${verb} response carried no payload`);
    try {
      return parse(response.payload);
    } catch (error) {
      throw new CapabilityError(verb, error instanceof Error ? error.message : String(error));
    }
  }
}
