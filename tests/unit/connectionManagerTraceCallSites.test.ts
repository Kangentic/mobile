/**
 * connectionManager.ts's connection-trace call sites (`lifecycle-start`,
 * `open-start`, `anchor-loaded`). traceConnection() is a hard no-op whenever
 * the trace flag is unset (connectionTrace.ts's own OFF-path guard, pinned by
 * connectionTrace.test.ts), so none of the OTHER connectionManager*.test.ts
 * files - which never set the flag and never mock this module - actually
 * observe whether these calls fire, fire in order, or carry the right
 * fields. This file mocks '@/devsupport/connectionTrace' directly so the
 * calls are visible regardless of the flag, the same shape as this suite's
 * existing mocks for the push-registration and crash-reporting doors.
 *
 * Scope, deliberately narrow: only the no-anchor path (secure-store reads
 * resolve to null), which reaches `lifecycle-start`, `open-start` and
 * `anchor-loaded` without ever constructing a ChannelController. Reaching
 * `identity-ready` needs a real, fully-populated trust anchor, which runs on
 * into `new ChannelController(...)` and its session/transport event wiring -
 * a stub for that sprawls well past a "mock one leaf module" test (session
 * onEstablished/onRekey/onRemoteClosed, transport.onStateChange, the feed).
 * Left uncovered here rather than built on a fragile partial stub; a
 * dedicated ChannelController-level fixture would be a separate, deliberate
 * piece of work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { startConnectionLifecycle, stopConnectionLifecycle } from '@/connection/connectionManager';
import { useChannelStore } from '@/state/channelStore';

const connectionTraceMocks = vi.hoisted(() => ({
  traceConnection: vi.fn<(event: string, fields?: Record<string, unknown>) => void>(),
  // Deliberately false by default, not true: if connectionManager.ts ever
  // hardcoded `cold: true` at the open-start call site instead of forwarding
  // this function's return value, a default of true would hide it.
  isColdLaunch: vi.fn<() => boolean>(() => false),
  foregroundKickEnabled: vi.fn<() => boolean>(() => true),
  markConnectionTraceForeground: vi.fn<() => void>(),
}));
vi.mock('@/devsupport/connectionTrace', () => connectionTraceMocks);

const crashReportingMocks = vi.hoisted(() => ({
  reportHandledError: vi.fn<(site: string, error: unknown) => void>(),
}));
vi.mock('@/observability/crashReporting', () => ({
  reportHandledError: crashReportingMocks.reportHandledError,
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: { OS: 'android' },
}));

const secureStoreMocks = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async () => null),
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMocks.getItemAsync,
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.stubGlobal('__DEV__', false);

describe('connectionManager trace call sites (no-anchor path)', () => {
  beforeEach(() => {
    stopConnectionLifecycle();
    useChannelStore.getState().setPairedState('unknown');
    secureStoreMocks.getItemAsync.mockReset();
    secureStoreMocks.getItemAsync.mockResolvedValue(null);
    connectionTraceMocks.traceConnection.mockClear();
    connectionTraceMocks.isColdLaunch.mockClear();
    connectionTraceMocks.isColdLaunch.mockReturnValue(false);
    crashReportingMocks.reportHandledError.mockClear();
  });

  /**
   * Mutation seen failing: deleting `traceConnection('lifecycle-start');`
   * from startConnectionLifecycle made the event list read
   * `['open-start', 'anchor-loaded']` instead of
   * `['lifecycle-start', 'open-start', 'anchor-loaded']` - "expected
   * [ 'open-start', 'anchor-loaded' ] to deeply equal
   * [ 'lifecycle-start', 'open-start', 'anchor-loaded' ]".
   */
  it('fires lifecycle-start, open-start, then anchor-loaded, in that order, on a no-anchor open', async () => {
    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));

    const events = connectionTraceMocks.traceConnection.mock.calls.map(([event]) => event);
    expect(events).toEqual(['lifecycle-start', 'open-start', 'anchor-loaded']);
  });

  /**
   * open-start's `cold` field must be READ from isColdLaunch(), not a
   * hardcoded literal - the default mock above returns false specifically so
   * a hardcoded `cold: true` cannot pass this test by accident.
   *
   * Mutation seen failing: changing
   * `traceConnection('open-start', { cold: isColdLaunch() });` to
   * `traceConnection('open-start', { cold: true });` made the asserted field
   * read `{ cold: true }` instead of `{ cold: false }` - "expected
   * { cold: true } to deeply equal { cold: false }".
   */
  it('open-start carries cold from isColdLaunch(), not a hardcoded value', async () => {
    connectionTraceMocks.isColdLaunch.mockReturnValue(false);

    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));

    const openStartCall = connectionTraceMocks.traceConnection.mock.calls.find(([event]) => event === 'open-start');
    expect(openStartCall?.[1]).toEqual({ cold: false });
  });

  /**
   * anchor-loaded must fire even when the anchor turns out to be null - i.e.
   * it has to run BEFORE the `if (!anchor) return;` early return, not after
   * it, since a trace call placed after that return would never execute on
   * the (very common - a fresh unpaired install) no-anchor path.
   *
   * Mutation seen failing: moving the anchor-loaded traceConnection call to
   * after `if (!anchor) { ...; return; }` made it never fire on this path -
   * "expected [ 'lifecycle-start', 'open-start' ] to deeply equal
   * [ 'lifecycle-start', 'open-start', 'anchor-loaded' ]".
   */
  it('anchor-loaded fires with paired=false before the no-anchor early return', async () => {
    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));

    const anchorLoadedCall = connectionTraceMocks.traceConnection.mock.calls.find(([event]) => event === 'anchor-loaded');
    expect(anchorLoadedCall).toBeDefined();
    expect(anchorLoadedCall?.[1]).toEqual({ ms: expect.any(Number), paired: false });
  });
});
