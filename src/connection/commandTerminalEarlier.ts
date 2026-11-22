import type { CommandTerminalEarlierResponsePayload } from '@kangentic/protocol';
import type { VerbClient } from '@/channel';
import { reportHandledError } from '@/observability/crashReporting';
import { selectEarlierConversationsOffered, useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { coalesced } from './coalescedRead';

/**
 * Reads of a project's Earlier list (protocol 0.24.0's `list-earlier`): the
 * desktop panel's ended Command Terminal conversations that can still be
 * resumed. The verb client is passed in rather than taken from
 * connectionManager, so the connection lifecycle and the feed glue can call
 * these without an import cycle; screens go through `fetchEarlierConversations`
 * in actions.ts.
 *
 * What makes a held list stale, and so re-reads it: the sheet opening, the
 * Board's Terminals button mounting, the desktop's `command-terminals-changed`
 * (a terminal started, was named or ended, which is when a conversation joins
 * or leaves Earlier), a stop of this phone's, and every bootstrap after a
 * reconnect. A rename or removal made in the desktop's own Earlier list sends
 * no event, so it shows on the next of those.
 */

/**
 * How many times one read goes back for a fresh answer when the phone changed
 * the list while the answer was on its way (the list's `revision` moved: a
 * resume took a conversation, or a gone one was dropped). The answer in hand
 * predates that change and would put the row back. Bounded, so a list the
 * phone keeps changing still settles; past the bound the last answer is kept.
 */
const STALE_ANSWER_REREADS = 2;

function earlierRevision(projectId: string): number {
  return useCommandTerminalStore.getState().earlierByProjectId[projectId]?.revision ?? 0;
}

/**
 * Reads one project's Earlier list into the store, one read at a time per
 * project (a request while one is in flight reads once more after it). The
 * rows last read stay on screen while it loads and if it fails.
 *
 * A failure is reported through the handled-error door (which drops the
 * normal no-connection errors by name) only when it leaves NOTHING held: the
 * sheet then says the list did not load, and the Board's Terminals button
 * reads as having nothing to resume. A failed refresh of a held list leaves
 * the rows last read on screen, a best-effort catch the next refresh repairs,
 * so it reports nothing (crash-reporting-scope.md).
 */
export function readEarlierConversations(verbs: VerbClient, projectId: string): Promise<void> {
  return coalesced(`earlier:${projectId}`, async () => {
    useCommandTerminalStore.getState().markEarlierLoading(projectId);
    for (let attempt = 0; ; attempt += 1) {
      const revisionAtRequest = earlierRevision(projectId);
      let answer: CommandTerminalEarlierResponsePayload;
      try {
        answer = await verbs.listEarlierCommandTerminalConversations(projectId);
      } catch (error) {
        useCommandTerminalStore.getState().markEarlierFailed(projectId);
        const heldConversations = useCommandTerminalStore.getState().earlierByProjectId[projectId]?.conversations ?? null;
        if (heldConversations === null) reportHandledError('command-terminal-earlier', error);
        return;
      }
      if (earlierRevision(projectId) === revisionAtRequest || attempt >= STALE_ANSWER_REREADS) {
        useCommandTerminalStore.getState().setEarlier(projectId, answer.conversations);
        return;
      }
    }
  });
}

/**
 * Re-reads a project's Earlier list only when the phone already holds one (a
 * screen asked for it this session) and the project's desktop still offers
 * it. So a board event for a project whose Board and sheet were never shown,
 * as the Agents feed of many projects produces, reads nothing. A held list is
 * never released, so a project shown once keeps re-reading on its terminals'
 * starts, names and ends: bounded by the projects shown, and those events are
 * rare.
 */
export function refreshHeldEarlierConversations(verbs: VerbClient, projectId: string): Promise<void> {
  if (useCommandTerminalStore.getState().earlierByProjectId[projectId] === undefined) return Promise.resolve();
  if (!selectEarlierConversationsOffered(useBoardStore.getState(), projectId)) return Promise.resolve();
  return readEarlierConversations(verbs, projectId);
}

/** Every held Earlier list, re-read: after a bootstrap, when anything may have changed while the phone was away. */
export function refreshAllHeldEarlierConversations(verbs: VerbClient): Promise<void> {
  const projectIds = Object.keys(useCommandTerminalStore.getState().earlierByProjectId);
  return Promise.all(projectIds.map((projectId) => refreshHeldEarlierConversations(verbs, projectId))).then(() => undefined);
}
