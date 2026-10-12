import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import CommandTerminalRoute from '../../app/command-terminal';

/**
 * `app/command-terminal.tsx` is a route wrapper whose whole job is to supply
 * `ScreenMotionProvider` around the Command Terminal screen, as
 * `app/task/[taskId]/index.tsx` does for the session screen. The provider is
 * what turns the starting face's blink and the header's spinning Stop ring OFF
 * while a route (the Changes tab's file diff) is pushed over the terminal. With
 * the wrapper dropped nothing else changes on screen: `useScreenMotionActive`
 * defaults to ACTIVE outside a provider (pinned in ScreenMotion.test.tsx), so
 * the loops would run unseen for as long as the terminal stays under another
 * route. The screen's own tests reach the gate through `ScreenMotionOverride`,
 * which bypasses this wrapper entirely, so this file is the only thing that
 * pins the wrapper.
 *
 * `expo-router`'s real `useFocusEffect` throws outside a navigator, so it is a
 * controllable double (the technique ScreenMotion.test.tsx documents): the
 * captured effect is replayed for a focus, and the cleanup it returns is the
 * blur a real navigator would run.
 *
 * Mutation seen failing: replacing `ScreenMotionProvider` with a fragment in the
 * route. Both tests went red on "no focus effect registered" ("expect(received)
 * .not.toBeNull(): Received: null", and the replayed focus returned no cleanup),
 * which is the wrapper missing, not a crash.
 */
const mockLatestFocusEffect: { current: (() => void | (() => void)) | null } = { current: null };

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockLatestFocusEffect.current = effect;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    require('react').useEffect(effect, [effect]);
  },
}));

// The screen itself is covered by CommandTerminalScreen.test.tsx. Here it is a
// readout of the one thing the wrapper must provide: the motion gate.
jest.mock('@/screens/terminals/CommandTerminalScreen', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { Text } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { useScreenMotionActive } = require('@/components/motion/ScreenMotion');
  return {
    __esModule: true,
    CommandTerminalScreen: function MockCommandTerminalScreen() {
      const active = useScreenMotionActive();
      return ReactModule.createElement(Text, { testID: 'terminal-motion-gate' }, active ? 'active' : 'inactive');
    },
  };
});

describe('the Command Terminal route (app/command-terminal.tsx)', () => {
  beforeEach(() => {
    mockLatestFocusEffect.current = null;
  });

  it('renders the Command Terminal screen under a motion provider, which is what registers a focus effect', async () => {
    await render(<CommandTerminalRoute />);

    expect(screen.getByTestId('terminal-motion-gate')).toBeTruthy();
    expect(mockLatestFocusEffect.current).not.toBeNull();
  });

  it('closes the screen motion gate when a route is pushed over the terminal, and reopens it on return', async () => {
    await render(<CommandTerminalRoute />);
    expect(screen.getByTestId('terminal-motion-gate').props.children).toBe('active');

    let blurCleanup: (() => void) | undefined;
    await act(() => {
      blurCleanup = mockLatestFocusEffect.current?.() ?? undefined;
    });
    expect(blurCleanup).toBeDefined();

    // Blur: the host navigator runs the cleanup the focus callback returned.
    await act(() => {
      blurCleanup?.();
    });
    expect(screen.getByTestId('terminal-motion-gate').props.children).toBe('inactive');

    // Refocus: the host navigator invokes the focus callback again.
    await act(() => {
      mockLatestFocusEffect.current?.();
    });
    expect(screen.getByTestId('terminal-motion-gate').props.children).toBe('active');
  });
});
