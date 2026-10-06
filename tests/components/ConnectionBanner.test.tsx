import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react-native';
import { ThemeProvider, ConnectionBanner } from '@/components';
import { useChannelStore } from '@/state/channelStore';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

/** Matches DEGRADED_GRACE_MS in ConnectionBanner. */
const GRACE_MS = 2000;

/** Matches ESCALATE_AFTER_MS in ConnectionBanner. */
const ESCALATE_MS = 20_000;

async function renderBanner(): Promise<void> {
  await render(
    <ThemeProvider>
      <ConnectionBanner />
    </ThemeProvider>,
  );
}

async function passGraceWindow(): Promise<void> {
  await act(() => {
    jest.advanceTimersByTime(GRACE_MS);
  });
}

describe('ConnectionBanner', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    mockPush.mockClear();
    // The banner only arms after the launch's first establishment; these
    // tests exercise the degraded states of a link that WAS working. The
    // escalated pill additionally requires a trust anchor (paired).
    await act(() => useChannelStore.setState({ everEstablished: true, pairedState: 'paired' }));
  });

  afterEach(async () => {
    await act(() =>
      useChannelStore.setState({
        transportState: 'idle',
        established: false,
        everEstablished: false,
        pairedState: 'unknown',
      }),
    );
    jest.useRealTimers();
  });

  it('never appears before the first establishment of the launch (cold start)', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connecting', established: false, everEstablished: false }));

    await renderBanner();
    await passGraceWindow();

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('renders nothing while connected and established', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    await renderBanner();
    await passGraceWindow();

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('stays hidden through the grace window, then shows the connecting message', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connecting', established: false }));

    await renderBanner();

    // A short dip must not flash the banner.
    expect(screen.queryByTestId('connection-banner')).toBeNull();

    await passGraceWindow();

    expect(screen.getByTestId('connection-banner')).toBeTruthy();
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the connecting message while reconnecting', async () => {
    await act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));

    await renderBanner();
    await passGraceWindow();

    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the connecting message while connected but not yet established (mid-handshake)', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connected', established: false }));

    await renderBanner();
    await passGraceWindow();

    // The socket is up and the desktop is re-initiating the KK handshake; this
    // is recovery, not an outage, so it must read as connecting (not "Offline").
    expect(screen.getByTestId('connection-banner')).toBeTruthy();
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the offline message when the transport is closed', async () => {
    await act(() => useChannelStore.setState({ transportState: 'closed', established: false }));

    await renderBanner();
    await passGraceWindow();

    expect(screen.getByText('Offline - showing last known state')).toBeTruthy();
  });

  it('never appears for a dip that recovers inside the grace window', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    await renderBanner();

    await act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));
    await act(() => {
      jest.advanceTimersByTime(GRACE_MS / 2);
    });
    await act(() => useChannelStore.setState({ transportState: 'connected', established: true }));
    await passGraceWindow();

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('hides immediately on recovery after being shown', async () => {
    await act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));

    await renderBanner();
    await passGraceWindow();
    expect(screen.getByTestId('connection-banner')).toBeTruthy();

    await act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('escalates to the pressable can-not-reach pill after the sustained stuck window', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connected', established: false }));

    await renderBanner();
    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS - 1);
    });

    // Right up to the deadline the mid-handshake state still reads as connecting.
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();

    await act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(screen.getByTestId('connection-banner-escalated')).toBeTruthy();
    expect(screen.getByText("Can't reach desktop - tap to manage device")).toBeTruthy();
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('shows the escalated pill on a stuck cold start despite everEstablished being false', async () => {
    await act(() =>
      useChannelStore.setState({ transportState: 'connected', established: false, everEstablished: false }),
    );

    await renderBanner();
    await passGraceWindow();

    // The plain pill stays suppressed on a cold start; only the sustained
    // silence past the escalation window is allowed through.
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();

    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS - GRACE_MS);
    });

    expect(screen.getByTestId('connection-banner-escalated')).toBeTruthy();
  });

  it('a break in the stuck condition resets the sustained window', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connected', established: false }));

    await renderBanner();
    await act(() => {
      jest.advanceTimersByTime(10_000);
    });

    // A relay blip interrupts the silent window; the count starts over.
    await act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));
    await act(() => useChannelStore.setState({ transportState: 'connected', established: false }));
    await act(() => {
      jest.advanceTimersByTime(15_000);
    });

    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();

    await act(() => {
      jest.advanceTimersByTime(5_000);
    });

    expect(screen.getByTestId('connection-banner-escalated')).toBeTruthy();
  });

  it('tapping the escalated pill routes to the devices screen', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connected', established: false }));

    await renderBanner();
    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS);
    });

    await fireEvent.press(screen.getByTestId('connection-banner-escalated'));

    // Devices is where unpairing lives, and unpairing is local: it clears the
    // trust anchor and needs no working channel, which is exactly why it is
    // reachable from a pill that says the desktop cannot be reached.
    expect(mockPush).toHaveBeenCalledWith('/devices');
  });

  it('hides immediately when the session establishes after escalation', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connected', established: false }));

    await renderBanner();
    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS);
    });
    expect(screen.getByTestId('connection-banner-escalated')).toBeTruthy();

    await act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();
    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('renders nothing while unpaired', async () => {
    await act(() =>
      useChannelStore.setState({ pairedState: 'unpaired', transportState: 'reconnecting', established: false }),
    );

    await renderBanner();
    await passGraceWindow();

    expect(screen.queryByTestId('connection-banner')).toBeNull();

    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS);
    });

    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();
  });

  it('does not escalate while the transport is merely connecting', async () => {
    await act(() => useChannelStore.setState({ transportState: 'connecting', established: false }));

    await renderBanner();
    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS * 2);
    });

    // Silence only counts against a CONNECTED transport: while the socket is
    // still dialing, the desktop has had no chance to answer.
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();
  });

  it('never escalates while pairedState is unknown (pre-bootstrap cold start)', async () => {
    await act(() =>
      useChannelStore.setState({
        pairedState: 'unknown',
        transportState: 'connected',
        established: false,
        everEstablished: false,
      }),
    );

    await renderBanner();
    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS * 2);
    });

    // Escalation requires a CERTAIN trust anchor ('paired'), not the
    // transient unknown while the anchor is still loading.
    expect(screen.queryByTestId('connection-banner')).toBeNull();
    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();
  });

  it('the offline pill never escalates or becomes pressable', async () => {
    await act(() => useChannelStore.setState({ transportState: 'closed', established: false }));

    await renderBanner();
    await act(() => {
      jest.advanceTimersByTime(ESCALATE_MS * 2);
    });

    // A dead transport means the RELAY is unreachable - a network problem the
    // devices screen cannot fix - so it stays the plain offline pill.
    expect(screen.getByText('Offline - showing last known state')).toBeTruthy();
    expect(screen.queryByTestId('connection-banner-escalated')).toBeNull();
  });
});
