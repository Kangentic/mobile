import type { SubscriptionManager, VerbClient } from '@/channel';
import { useBoardStore } from '@/state/boardStore';

/**
 * Runs on every established handshake (cheap, and it doubles as the
 * reconnect resync since the desktop tears its subscription registry down
 * when a device drops):
 *
 * 1. Project list -> boardStore.
 * 2. Declare every project's board desired; each snapshot flows back
 *    through the sinks (storeFeed.ts), which register live sessions and
 *    re-declare the desired stream set - so the stream fan-out follows the
 *    boards, not this function (R4: live sessions come from board
 *    snapshots' non-null session_id, there is no session-list verb).
 */
export async function runBootstrap(verbs: VerbClient, subscriptions: SubscriptionManager): Promise<void> {
  const projectList = await verbs.readProjectList();
  useBoardStore.getState().applyProjectList(projectList.projects, projectList.groups);
  subscriptions.setDesiredBoards(new Set(projectList.projects.map((project) => project.id)));
}
