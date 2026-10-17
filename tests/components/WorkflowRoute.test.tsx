import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import WorkflowRoute from '../../app/workflow';

/**
 * `app/workflow.tsx` is a route wrapper whose whole job is to supply
 * `ScreenMotionProvider` around the workflow view, as the session route and the
 * Command Terminal route do. The provider is what stops the cards' working rings
 * while a route (a task opened from the view) is pushed over it. With the wrapper
 * dropped nothing else changes on screen: `useScreenMotionActive` defaults to
 * ACTIVE outside a provider (pinned in ScreenMotion.test.tsx), so the rings would
 * keep turning unseen under the pushed route. The screen's own tests render it
 * without the wrapper, so this file is the only thing that pins it.
 *
 * `expo-router`'s real `useFocusEffect` throws outside a navigator, so it is a
 * controllable double (the technique CommandTerminalRoute.test.tsx documents):
 * the captured effect is replayed for a focus, and the cleanup it returns is the
 * blur a real navigator would run.
 */
const mockLatestFocusEffect: { current: (() => void | (() => void)) | null } = { current: null };

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockLatestFocusEffect.current = effect;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    require('react').useEffect(effect, [effect]);
  },
}));

// The screen itself is covered by WorkflowScreen.test.tsx. Here it is a readout
// of the one thing the wrapper must provide: the motion gate.
jest.mock('@/screens/workflow/WorkflowScreen', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { Text } = require('react-native');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { useScreenMotionActive } = require('@/components/motion/ScreenMotion');
  return {
    __esModule: true,
    WorkflowScreen: function MockWorkflowScreen() {
      const active = useScreenMotionActive();
      return ReactModule.createElement(Text, { testID: 'workflow-motion-gate' }, active ? 'active' : 'inactive');
    },
  };
});

describe('the workflow route (app/workflow.tsx)', () => {
  beforeEach(() => {
    mockLatestFocusEffect.current = null;
  });

  /**
   * Mutation seen failing: replacing `ScreenMotionProvider` with a fragment in
   * the route, which left no focus effect registered.
   */
  it('renders the workflow screen under a motion provider, which is what registers a focus effect', async () => {
    await render(<WorkflowRoute />);

    expect(screen.getByTestId('workflow-motion-gate')).toBeTruthy();
    expect(mockLatestFocusEffect.current).not.toBeNull();
  });

  it('closes the screen motion gate when a route is pushed over the view, and reopens it on return', async () => {
    await render(<WorkflowRoute />);
    expect(screen.getByTestId('workflow-motion-gate').props.children).toBe('active');

    let blurCleanup: (() => void) | undefined;
    await act(() => {
      blurCleanup = mockLatestFocusEffect.current?.() ?? undefined;
    });
    expect(blurCleanup).toBeDefined();

    // Blur: the host navigator runs the cleanup the focus callback returned.
    await act(() => {
      blurCleanup?.();
    });
    expect(screen.getByTestId('workflow-motion-gate').props.children).toBe('inactive');

    // Refocus: the host navigator invokes the focus callback again.
    await act(() => {
      mockLatestFocusEffect.current?.();
    });
    expect(screen.getByTestId('workflow-motion-gate').props.children).toBe('active');
  });
});
