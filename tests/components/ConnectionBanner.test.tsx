import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { ThemeProvider, ConnectionBanner } from '@/components';
import { useChannelStore } from '@/state/channelStore';

/** Matches DEGRADED_GRACE_MS in ConnectionBanner. */
const GRACE_MS = 2000;

function renderBanner(): void {
  render(
    <ThemeProvider>
      <ConnectionBanner />
    </ThemeProvider>,
  );
}

function passGraceWindow(): void {
  act(() => {
    jest.advanceTimersByTime(GRACE_MS);
  });
}

describe('ConnectionBanner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => useChannelStore.setState({ transportState: 'idle', established: false }));
    jest.useRealTimers();
  });

  it('renders nothing while connected and established', () => {
    act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    renderBanner();
    passGraceWindow();

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('stays hidden through the grace window, then shows the connecting message', () => {
    act(() => useChannelStore.setState({ transportState: 'connecting', established: false }));

    renderBanner();

    // A short dip must not flash the banner.
    expect(screen.queryByTestId('connection-banner')).toBeNull();

    passGraceWindow();

    expect(screen.getByTestId('connection-banner')).toBeTruthy();
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the connecting message while reconnecting', () => {
    act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));

    renderBanner();
    passGraceWindow();

    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the connecting message while connected but not yet established (mid-handshake)', () => {
    act(() => useChannelStore.setState({ transportState: 'connected', established: false }));

    renderBanner();
    passGraceWindow();

    // The socket is up and the desktop is re-initiating the KK handshake; this
    // is recovery, not an outage, so it must read as connecting (not "Offline").
    expect(screen.getByTestId('connection-banner')).toBeTruthy();
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the offline message when the transport is closed', () => {
    act(() => useChannelStore.setState({ transportState: 'closed', established: false }));

    renderBanner();
    passGraceWindow();

    expect(screen.getByText('Offline - showing last known state')).toBeTruthy();
  });

  it('never appears for a dip that recovers inside the grace window', () => {
    act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    renderBanner();

    act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));
    act(() => {
      jest.advanceTimersByTime(GRACE_MS / 2);
    });
    act(() => useChannelStore.setState({ transportState: 'connected', established: true }));
    passGraceWindow();

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('hides immediately on recovery after being shown', () => {
    act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));

    renderBanner();
    passGraceWindow();
    expect(screen.getByTestId('connection-banner')).toBeTruthy();

    act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });
});
