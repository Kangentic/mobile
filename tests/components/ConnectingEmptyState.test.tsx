import React from 'react';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react-native';
import { ConnectingEmptyState } from '@/screens/home/ConnectingEmptyState';

const mockPush = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

describe('ConnectingEmptyState', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockPush.mockClear();
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it('narrates progress without offering recovery while connecting is still plausible', () => {
    render(<ConnectingEmptyState />);

    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();
    // A cold start over a hosted relay takes seconds; offering "something is
    // wrong" immediately would be noise on every launch.
    expect(screen.queryByTestId('connecting-manage-device')).toBeNull();
  });

  /**
   * The recovery path this screen exists to signpost. Without it a phone that
   * never establishes has no timeout, no error, and no route to unpairing -
   * leaving reinstalling the app as the only way out.
   */
  it('offers a route to the device screen once it has been connecting too long', () => {
    render(<ConnectingEmptyState />);

    act(() => {
      jest.advanceTimersByTime(20_000);
    });

    expect(screen.getByTestId('connecting-manage-device')).toBeTruthy();
    fireEvent.press(screen.getByTestId('connecting-manage-device'));
    // Devices is where unpairing lives, and unpairing is local: it clears the
    // trust anchor and needs no working channel, which is exactly why it is
    // reachable from a screen that is stuck.
    expect(mockPush).toHaveBeenCalledWith('/devices');
  });
});
