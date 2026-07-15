import React from 'react';
import { render, screen, act } from '@testing-library/react-native';
import { ThemeProvider, ConnectionBanner } from '@/components';
import { useChannelStore } from '@/state/channelStore';

describe('ConnectionBanner', () => {
  afterEach(() => {
    act(() => useChannelStore.setState({ transportState: 'idle', established: false }));
  });

  it('renders nothing while connected and established', () => {
    act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    render(
      <ThemeProvider>
        <ConnectionBanner />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('connection-banner')).toBeNull();
  });

  it('shows the connecting message while the transport is connecting', () => {
    act(() => useChannelStore.setState({ transportState: 'connecting', established: false }));

    render(
      <ThemeProvider>
        <ConnectionBanner />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('connection-banner')).toBeTruthy();
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the connecting message while reconnecting', () => {
    act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));

    render(
      <ThemeProvider>
        <ConnectionBanner />
      </ThemeProvider>,
    );

    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the connecting message while connected but not yet established (mid-handshake)', () => {
    act(() => useChannelStore.setState({ transportState: 'connected', established: false }));

    render(
      <ThemeProvider>
        <ConnectionBanner />
      </ThemeProvider>,
    );

    // The socket is up and the desktop is re-initiating the KK handshake; this
    // is recovery, not an outage, so it must read as connecting (not "Offline").
    expect(screen.getByTestId('connection-banner')).toBeTruthy();
    expect(screen.getByText('Connecting to desktop...')).toBeTruthy();
  });

  it('shows the offline message when the transport is closed', () => {
    act(() => useChannelStore.setState({ transportState: 'closed', established: false }));

    render(
      <ThemeProvider>
        <ConnectionBanner />
      </ThemeProvider>,
    );

    expect(screen.getByText('Offline - showing last known state')).toBeTruthy();
  });

  it('updates reactively when the store changes', () => {
    act(() => useChannelStore.setState({ transportState: 'connected', established: true }));

    render(
      <ThemeProvider>
        <ConnectionBanner />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('connection-banner')).toBeNull();

    act(() => useChannelStore.setState({ transportState: 'reconnecting', established: false }));

    expect(screen.getByTestId('connection-banner')).toBeTruthy();
  });
});
