/**
 * The mock desktop's `/link-stream` command (task #147): the link-scan probe's
 * full-rate stream, driven through a REAL ChannelController over the loopback,
 * the stack a demo pairing runs.
 *
 * The command exists only in a retention-probe build, so each case loads the
 * modules fresh with the probe flag set or not: `retentionProbe.ts` reads the
 * flag once, at module load, exactly as a release bundle inlines it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from '@kangentic/protocol';
import type { ChannelController } from '@/channel';
import type { MockDesktop } from '@/connection/mockDesktop';
import { waitUntil } from '../helpers/async';

interface Rig {
  controller: ChannelController;
  mockDesktop: MockDesktop;
  codexSessionId: string;
  codexTaskId: string;
  codexTuiSeed: string;
  codexTuiFrame: (paintTick: number) => string;
  codexTerminalEvents: () => string[];
  linkStream: typeof import('@/devsupport/terminalLinkStream');
  grid: { cols: number; rows: number };
}

let activeRig: Rig | null = null;

async function connectRig(probeCompiledIn: boolean): Promise<Rig> {
  vi.resetModules();
  if (probeCompiledIn) vi.stubEnv('EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE', '1');
  const channelModule = await import('@/channel');
  const mockModule = await import('@/connection/mockDesktop');
  const linkStream = await import('@/devsupport/terminalLinkStream');
  const mockDesktop = mockModule.createMockDesktop();
  const controller = new channelModule.ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://link-stream-test',
    transport: mockDesktop.phoneTransport,
  });
  const codexSessionId = mockModule.MOCK_CODEX_STATIC_SESSION.sessionId;
  const terminalEvents: string[] = [];
  controller.feed.on('terminal', (event: BridgeEvent) => {
    if (event.kind === 'terminal' && event.sessionId === codexSessionId) terminalEvents.push(event.payload.data);
  });
  await controller.connect();
  await mockDesktop.start();
  await waitUntil(() => controller.session.isEstablished, { label: 'loopback session establishes' });
  activeRig = {
    controller,
    mockDesktop,
    codexSessionId,
    codexTaskId: mockModule.MOCK_CODEX_STATIC_SESSION.taskId,
    codexTuiSeed: mockModule.codexTuiFrameForTest(0),
    codexTuiFrame: mockModule.codexTuiFrameForTest,
    codexTerminalEvents: () => terminalEvents,
    linkStream,
    grid: mockModule.activeGrid(),
  };
  return activeRig;
}

afterEach(() => {
  activeRig?.controller.dispose();
  activeRig?.mockDesktop.dispose();
  activeRig = null;
  vi.unstubAllEnvs();
});

describe('without the retention probe (every shipped build, the demo included)', () => {
  /**
   * Mutation that reddens this: drop the `retentionProbeEnabled()` check on
   * the command, so the shipped demo's codex terminal becomes the stream.
   */
  it('treats /link-stream as an ordinary message and leaves the codex terminal alone', async () => {
    const rig = await connectRig(false);

    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream scroll');
    const snapshot = await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });

    expect(snapshot.scrollback).toBe(rig.codexTuiSeed);
    // The command reached the transcript as the words it is.
    const transcript = await rig.controller.verbs.readTranscriptWindow(rig.codexSessionId);
    expect(JSON.stringify(transcript.entries)).toContain('/link-stream scroll');
  });
});

describe('with the retention probe compiled in', () => {
  it('replaces the codex terminal with the scenario and streams its ticks while subscribed', async () => {
    const rig = await connectRig(true);

    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream scroll');
    const snapshot = await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    expect(snapshot.scrollback).toBe(rig.linkStream.linkStreamSeedFrame('scroll', rig.grid));

    // Ticks every 16 ms: several within a quarter second, each the next entry.
    await waitUntil(() => rig.codexTerminalEvents().length >= 5, { label: 'link stream ticks arrive', timeoutMs: 2000 });
    expect(rig.codexTerminalEvents().slice(0, 3)).toEqual([
      rig.linkStream.linkStreamTickFrame('scroll', 1, rig.grid),
      rig.linkStream.linkStreamTickFrame('scroll', 2, rig.grid),
      rig.linkStream.linkStreamTickFrame('scroll', 3, rig.grid),
    ]);
  });

  /**
   * A list-only re-subscribe is how the phone closes a session screen, and an
   * A/B arm closes one between every window, so the stream must stop there or
   * it keeps encrypting frames nobody reads.
   *
   * Mutation that reddens this: drop the startLinkStream() call from the codex
   * subscribe branch (the timer then outlives the terminal).
   */
  it('stops on a list-only re-subscribe and on /link-stream off', async () => {
    const rig = await connectRig(true);
    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream still');
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    await waitUntil(() => rig.codexTerminalEvents().length >= 2, { label: 'still ticks arrive' });

    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: false });
    const countAfterClose = rig.codexTerminalEvents().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rig.codexTerminalEvents().length).toBe(countAfterClose);

    // Reopened, it streams again; switched off, the codex TUI is back.
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    await waitUntil(() => rig.codexTerminalEvents().length >= countAfterClose + 2, { label: 'reopened stream ticks' });
    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream off');
    await waitUntil(() => rig.codexTerminalEvents().includes(rig.codexTuiSeed), { label: 'off repaints the codex TUI' });
    const countAfterOff = rig.codexTerminalEvents().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rig.codexTerminalEvents().length).toBe(countAfterOff);
    const reopened = await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    expect(reopened.scrollback).toBe(rig.codexTuiSeed);
  });

  /**
   * Mutation that reddens this: make endCodexTerminalStream() not call
   * stopLinkStream(), so an explicit unsubscribe leaves the timer running.
   */
  it('stops on the read-stream unsubscribe action', async () => {
    const rig = await connectRig(true);
    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream still');
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    await waitUntil(() => rig.codexTerminalEvents().length >= 2, { label: 'still ticks arrive' });

    await rig.controller.verbs.readStreamUnsubscribe(rig.codexSessionId);
    const countAfterUnsubscribe = rig.codexTerminalEvents().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rig.codexTerminalEvents().length).toBe(countAfterUnsubscribe);
  });

  /**
   * The codex task is paused through the pause-session verb; the mock ends the
   * session after MOCK_SUSPEND_EXIT_MS, and only then must the stream stop.
   *
   * Mutation that reddens this: the same as the unsubscribe case, since the
   * pause path also ends the stream through endCodexTerminalStream().
   */
  it('stops when the codex task is paused', async () => {
    const rig = await connectRig(true);
    let sessionEnded = false;
    rig.controller.feed.on('activity', (event: BridgeEvent) => {
      if (event.kind === 'activity' && event.sessionId === rig.codexSessionId && event.payload.type === 'session-ended') {
        sessionEnded = true;
      }
    });
    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream still');
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    await waitUntil(() => rig.codexTerminalEvents().length >= 2, { label: 'still ticks arrive' });

    let pausedProjectId: string | null = null;
    for (const projectId of ['mock-project', 'mock-project-relay']) {
      const board = await rig.controller.verbs.readBoardSubscribe(projectId, { view: 'full' });
      if (board.tasks.some((task) => task.id === rig.codexTaskId)) pausedProjectId = projectId;
    }
    expect(pausedProjectId).not.toBeNull();
    await rig.controller.verbs.pauseSession({ taskId: rig.codexTaskId, projectId: pausedProjectId ?? '' });
    await waitUntil(() => sessionEnded, { label: 'codex session ends', timeoutMs: 4000 });

    const countAfterPause = rig.codexTerminalEvents().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(rig.codexTerminalEvents().length).toBe(countAfterPause);
  });

  /**
   * After dispose the peer is gone, so a surviving timer emits nothing
   * visible: assert the mechanism, that the 16 ms interval handle was cleared.
   *
   * Mutation that reddens this: drop stopLinkStream() from dispose().
   */
  it('clears its tick timer on dispose', async () => {
    const rig = await connectRig(true);
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream still');
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });

    const tickTimerHandles = setIntervalSpy.mock.calls
      .map((call, index) => (call[1] === rig.linkStream.TERMINAL_LINK_STREAM_TICK_MS ? setIntervalSpy.mock.results[index].value : undefined))
      .filter((handle) => handle !== undefined);
    expect(tickTimerHandles.length).toBeGreaterThan(0);
    const liveHandle = tickTimerHandles[tickTimerHandles.length - 1];
    clearIntervalSpy.mockClear();

    rig.mockDesktop.dispose();
    expect(clearIntervalSpy.mock.calls.some((call) => call[0] === liveHandle)).toBe(true);

    // The afterEach would dispose the desktop a second time.
    rig.controller.dispose();
    activeRig = null;
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  /**
   * Real wait: the codex repaint fires on every even feed tick (about 2 s).
   *
   * Mutation that reddens this: drop `linkStreamMode === null &&` from the
   * repaint condition; a codex TUI frame then lands among the ticks.
   */
  it('keeps the 2 s codex TUI repaint down while a stream is set', async () => {
    const rig = await connectRig(true);
    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream still');
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });

    await new Promise((resolve) => setTimeout(resolve, 2300));

    const events = rig.codexTerminalEvents();
    expect(events.length).toBeGreaterThan(20);
    events.forEach((data, index) => {
      expect(data).toBe(rig.linkStream.linkStreamTickFrame('still', index + 1, rig.grid));
    });
  }, 10000);

  /**
   * Mutation that reddens this: drop the emit from the command branch, so an
   * already-open codex terminal is only switched at its next subscribe.
   */
  it('repaints an already-open codex terminal at once when the command arrives', async () => {
    const rig = await connectRig(true);
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    expect(rig.codexTerminalEvents().length).toBe(0);

    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream scroll');
    await waitUntil(() => rig.codexTerminalEvents().length >= 2, { label: 'seed and a tick arrive' });

    expect(rig.codexTerminalEvents()[0]).toBe(rig.linkStream.linkStreamSeedFrame('scroll', rig.grid));
    expect(rig.codexTerminalEvents()[1]).toBe(rig.linkStream.linkStreamTickFrame('scroll', 1, rig.grid));
  });

  /**
   * Mutation that reddens this: hoist `let tick = 0` out of startLinkStream()
   * so the count persists across a re-subscribe.
   */
  it('restarts its ticks from 1 on a fresh subscribe', async () => {
    const rig = await connectRig(true);
    await rig.controller.verbs.sendUserMessage(rig.codexSessionId, '/link-stream scroll');
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    await waitUntil(() => rig.codexTerminalEvents().length >= 4, { label: 'first run ticks arrive' });

    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: false });
    const countAfterClose = rig.codexTerminalEvents().length;
    await rig.controller.verbs.readStreamSubscribe(rig.codexSessionId, { terminal: true });
    await waitUntil(() => rig.codexTerminalEvents().length > countAfterClose, { label: 'second run ticks arrive' });

    expect(rig.codexTerminalEvents()[countAfterClose]).toBe(rig.linkStream.linkStreamTickFrame('scroll', 1, rig.grid));
  });
});
