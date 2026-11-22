/**
 * The Earlier list's reads (protocol 0.24.0, task #160): one read per project
 * at a time, the rows last read kept through a reload and a failure, and an
 * answer that predates a change the phone made itself (a resumed or gone
 * conversation dropped) discarded and read again, so it cannot put the row
 * back. The held-only refreshes read nothing for a project nobody asked about.
 *
 * The verb client is a hand-made double whose answers the test settles, so the
 * order of a drop against an answer in flight is exact rather than timed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandTerminalEarlierConversationWire, CommandTerminalEarlierResponsePayload } from '@kangentic/protocol';
import type { VerbClient } from '@/channel';
import { readEarlierConversations, refreshAllHeldEarlierConversations, refreshHeldEarlierConversations } from '@/connection/commandTerminalEarlier';
import { useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { boardSnapshotFixture } from '@/devsupport/desktopFixtures';
import { flushMicrotasks } from '../helpers/async';

const mocks = vi.hoisted(() => ({ reportHandledError: vi.fn() }));
vi.mock('@/observability/crashReporting', () => ({ reportHandledError: mocks.reportHandledError }));

const PROJECT_ID = 'project-1';
const resumed: CommandTerminalEarlierConversationWire = { agentSessionId: 'conversation-a', name: 'Audit image sizes', endedAt: '2026-11-22T08:00:00.000Z' };
const kept: CommandTerminalEarlierConversationWire = { agentSessionId: 'conversation-b', name: null, endedAt: '2026-11-14T08:00:00.000Z' };

interface PendingAnswer {
  resolve: (conversations: CommandTerminalEarlierConversationWire[]) => void;
  reject: (error: unknown) => void;
}

/** A verb client whose list reads wait until the test answers them, one at a time, in order. */
function deferredVerbClient(): { verbs: VerbClient; pending: PendingAnswer[]; requestCount: () => number } {
  const pending: PendingAnswer[] = [];
  let requests = 0;
  const listEarlierCommandTerminalConversations = (projectId: string): Promise<CommandTerminalEarlierResponsePayload> => {
    requests += 1;
    return new Promise((resolve, reject) => {
      pending.push({ resolve: (conversations) => resolve({ ok: true, projectId, conversations }), reject });
    });
  };
  return { verbs: { listEarlierCommandTerminalConversations } as unknown as VerbClient, pending, requestCount: () => requests };
}

function earlier() {
  return useCommandTerminalStore.getState().earlierByProjectId[PROJECT_ID];
}

function offerEarlier(offered: boolean, projectId = PROJECT_ID): void {
  useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId, tasks: [], earlierConversationsOffered: offered }));
}

beforeEach(() => {
  mocks.reportHandledError.mockReset();
  useBoardStore.getState().reset();
  useCommandTerminalStore.getState().reset();
});

describe('readEarlierConversations', () => {
  it('is loading at once, and lands the desktop\'s list as ready', async () => {
    const client = deferredVerbClient();

    const read = readEarlierConversations(client.verbs, PROJECT_ID);
    expect(earlier()).toMatchObject({ status: 'loading', conversations: null });

    client.pending[0].resolve([resumed, kept]);
    await read;
    expect(earlier()).toMatchObject({ status: 'ready', conversations: [resumed, kept] });
  });

  it('runs one read at a time per project, and reads once more after it when asked again meanwhile', async () => {
    const client = deferredVerbClient();

    const first = readEarlierConversations(client.verbs, PROJECT_ID);
    void readEarlierConversations(client.verbs, PROJECT_ID);
    void readEarlierConversations(client.verbs, PROJECT_ID);
    expect(client.requestCount()).toBe(1);

    client.pending[0].resolve([resumed]);
    await flushMicrotasks();
    expect(client.requestCount()).toBe(2);
    client.pending[1].resolve([kept]);
    await first;

    expect(client.requestCount()).toBe(2);
    expect(earlier()?.conversations).toEqual([kept]);
  });

  /**
   * The order that would leave a list stuck: a read is in flight, the phone
   * drops a row (a resume succeeded), and nothing else asks for a read. The
   * answer predates the drop and would put the row back, so the read itself
   * goes back for a fresh one. Mutation seen failing: applying the answer
   * whatever the revision - the resumed row comes back.
   */
  it('discards an answer that predates a local drop and reads again, with no second request needed', async () => {
    const client = deferredVerbClient();
    useCommandTerminalStore.getState().setEarlier(PROJECT_ID, [resumed, kept]);

    const read = readEarlierConversations(client.verbs, PROJECT_ID);
    useCommandTerminalStore.getState().dropEarlierConversation(PROJECT_ID, 'conversation-a');
    client.pending[0].resolve([resumed, kept]);
    await flushMicrotasks();

    expect(client.requestCount()).toBe(2);
    expect(earlier()?.conversations).toEqual([kept]);
    expect(earlier()?.status).toBe('loading');

    client.pending[1].resolve([kept]);
    await read;
    expect(earlier()).toMatchObject({ status: 'ready', conversations: [kept] });
  });

  it('settles after three reads even while the phone keeps changing the list, keeping the last answer', async () => {
    const client = deferredVerbClient();
    useCommandTerminalStore.getState().setEarlier(PROJECT_ID, [resumed, kept]);

    const read = readEarlierConversations(client.verbs, PROJECT_ID);
    for (let answer = 0; answer < 3; answer += 1) {
      useCommandTerminalStore.getState().dropEarlierConversation(PROJECT_ID, `conversation-gone-${answer}`);
      client.pending[answer].resolve([kept]);
      await flushMicrotasks();
    }
    await read;

    expect(client.requestCount()).toBe(3);
    expect(earlier()).toMatchObject({ status: 'ready', conversations: [kept] });
  });

  /**
   * A failed refresh of a held list leaves the rows last read on screen, a
   * best-effort catch: reporting it would put every timed-out background
   * refresh on the crash trail. Mutation seen failing: reporting whatever is
   * held.
   */
  it('keeps the rows last read when a read fails, and reports nothing while rows are held', async () => {
    const client = deferredVerbClient();
    useCommandTerminalStore.getState().setEarlier(PROJECT_ID, [kept]);
    const failure = new Error('relay dropped');

    const read = readEarlierConversations(client.verbs, PROJECT_ID);
    client.pending[0].reject(failure);
    await read;

    expect(earlier()).toMatchObject({ status: 'failed', conversations: [kept] });
    expect(mocks.reportHandledError).not.toHaveBeenCalled();
  });

  it('reports a failed read through the door when it leaves nothing held, the state the sheet shows as a failure', async () => {
    const client = deferredVerbClient();
    const failure = new Error('relay dropped');

    const read = readEarlierConversations(client.verbs, PROJECT_ID);
    client.pending[0].reject(failure);
    await read;

    expect(earlier()).toMatchObject({ status: 'failed', conversations: null });
    expect(mocks.reportHandledError).toHaveBeenCalledWith('command-terminal-earlier', failure);
  });

  it('reports nothing for a read that succeeds', async () => {
    const client = deferredVerbClient();

    const read = readEarlierConversations(client.verbs, PROJECT_ID);
    client.pending[0].resolve([]);
    await read;

    expect(mocks.reportHandledError).not.toHaveBeenCalled();
  });
});

describe('refreshHeldEarlierConversations', () => {
  it('reads nothing for a project whose list nobody has asked for', async () => {
    const client = deferredVerbClient();
    offerEarlier(true);

    await refreshHeldEarlierConversations(client.verbs, PROJECT_ID);

    expect(client.requestCount()).toBe(0);
    expect(earlier()).toBeUndefined();
  });

  it('reads nothing once the desktop no longer offers Earlier, even for a held list', async () => {
    const client = deferredVerbClient();
    offerEarlier(false);
    useCommandTerminalStore.getState().setEarlier(PROJECT_ID, [kept]);

    await refreshHeldEarlierConversations(client.verbs, PROJECT_ID);

    expect(client.requestCount()).toBe(0);
  });

  it('re-reads a held list the desktop offers', async () => {
    const client = deferredVerbClient();
    offerEarlier(true);
    useCommandTerminalStore.getState().setEarlier(PROJECT_ID, [kept]);

    const refresh = refreshHeldEarlierConversations(client.verbs, PROJECT_ID);
    expect(earlier()?.status).toBe('loading');
    client.pending[0].resolve([resumed, kept]);
    await refresh;

    expect(earlier()?.conversations).toEqual([resumed, kept]);
  });
});

describe('refreshAllHeldEarlierConversations', () => {
  it('re-reads every held list, and only those', async () => {
    const client = deferredVerbClient();
    offerEarlier(true, 'project-1');
    offerEarlier(true, 'project-2');
    offerEarlier(true, 'project-3');
    useCommandTerminalStore.getState().setEarlier('project-1', []);
    useCommandTerminalStore.getState().markEarlierFailed('project-2');

    const refresh = refreshAllHeldEarlierConversations(client.verbs);
    expect(client.requestCount()).toBe(2);
    for (const answer of client.pending) answer.resolve([]);
    await refresh;

    expect(useCommandTerminalStore.getState().earlierByProjectId['project-3']).toBeUndefined();
    expect(useCommandTerminalStore.getState().earlierByProjectId['project-2']?.status).toBe('ready');
  });
});
