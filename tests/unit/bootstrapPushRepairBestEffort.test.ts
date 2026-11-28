/**
 * The bootstrap's push repair is best-effort (bootstrap.ts): a repair that
 * fails must never fail the bootstrap, which feeds connectionManager's retry
 * chain, and must not surface as an unhandled rejection. The REAL
 * pushRegistration module is replaced here (bootstrapPushRegistration.test.ts
 * uses it for real), by one whose registerPushAgainWithDesktop rejects.
 *
 * Mutation seen failing: removing the `.catch(...)` on the lazy import chain in
 * runBootstrap, after which vitest reports the rejection as an unhandled error
 * and fails the run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionManager } from '@/channel/subscriptionManager';
import type { VerbClient } from '@/channel/verbClient';
import { runBootstrap } from '@/connection/bootstrap';
import { useBoardStore } from '@/state/boardStore';

const pushRegistrationMocks = vi.hoisted(() => ({
  registerPushAgainWithDesktop: vi.fn<(verbs: unknown) => Promise<void>>(),
}));

vi.mock('@/notifications/pushRegistration', () => ({
  registerPushAgainWithDesktop: pushRegistrationMocks.registerPushAgainWithDesktop,
}));

beforeEach(() => {
  useBoardStore.getState().reset();
  pushRegistrationMocks.registerPushAgainWithDesktop.mockReset();
});

describe('the bootstrap push repair is best-effort', () => {
  it('resolves, and keeps the board it applied, when the repair rejects', async () => {
    pushRegistrationMocks.registerPushAgainWithDesktop.mockRejectedValue(new Error('repair failed'));
    const verbs = {
      readProjectList: vi.fn(async () => ({ projects: [{ id: 'project-1', name: 'Alpha' }], pushRegistered: false })),
    } as unknown as VerbClient;
    const subscriptions = { setDesiredBoards: vi.fn() } as unknown as SubscriptionManager;

    await expect(runBootstrap(verbs, subscriptions, { demoConnection: false })).resolves.toBeUndefined();
    // The repair is fire-and-forget behind a lazy import: wait for it to have run
    // and for its rejection to have been handled (or not) before the test ends.
    await vi.waitFor(() => expect(pushRegistrationMocks.registerPushAgainWithDesktop).toHaveBeenCalledWith(verbs));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useBoardStore.getState().projects).toEqual([{ id: 'project-1', name: 'Alpha' }]);
    expect(subscriptions.setDesiredBoards).toHaveBeenCalledTimes(1);
  });
});
