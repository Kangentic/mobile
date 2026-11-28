import type { SubscriptionManager, VerbClient } from '@/channel';
import { traceConnection } from '@/devsupport/connectionTrace';
import { useBoardStore } from '@/state/boardStore';

export interface BootstrapOptions {
  /**
   * The demo pairing's in-process desktop (connectionManager.ts's
   * `demoConnection`). It never registers for push: registering starts with an
   * HTTPS call to Expo's push service, and the demo must stay networkless.
   * Required, so that no caller registers by default.
   */
  demoConnection: boolean;
}

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
 * 3. When the project list says the desktop holds no push registration for
 *    this phone (`pushRegistered: false`, protocol 0.30.0), register again,
 *    although this process may have registered already. The desktop can lose
 *    one (Sentry DESKTOP-5H: it sets a corrupt registrations file aside and
 *    starts empty), and the phone otherwise registers once per process. Only
 *    an explicit false counts: an older desktop, one that cannot read its
 *    registrations, and a device without the register-push grant all omit the
 *    field, which reads as registered.
 */
export async function runBootstrap(verbs: VerbClient, subscriptions: SubscriptionManager, options: BootstrapOptions): Promise<void> {
  traceConnection('bootstrap-start');
  const projectList = await verbs.readProjectList();
  traceConnection('project-list', { projects: projectList.projects.length });
  useBoardStore.getState().applyProjectList(projectList.projects, projectList.groups);
  subscriptions.setDesiredBoards(new Set(projectList.projects.map((project) => project.id)));
  if (projectList.pushRegistered === false && !options.demoConnection) {
    // Fire and forget, as the established-handshake registration in
    // connectionManager.ts is: never awaited, so a slow Expo token fetch cannot
    // hold the bootstrap or feed its retry. Imported lazily for the same reason
    // that one is: the module reaches expo-notifications and expo-constants,
    // which the many suites that load this file do not stub. The demo gate is
    // here because only the connection knows it is the demo; the
    // notifications-off gate is registerPushAgainWithDesktop's own.
    void import('@/notifications/pushRegistration')
      .then(({ registerPushAgainWithDesktop }) => registerPushAgainWithDesktop(verbs))
      .catch(() => {
        // Best-effort; the next bootstrap that reads false tries again.
      });
  }
}
