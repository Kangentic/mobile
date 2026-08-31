import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { ScreenMotionOverride, ScreenMotionProvider, useScreenMotionActive } from '@/components/motion/ScreenMotion';

/**
 * `app/(tabs)/index.tsx` and `app/(tabs)/board.tsx` wrap the Home and Board
 * screens in `ScreenMotionProvider`, so its focus/blur wiring is real,
 * shipped behaviour, not test scaffolding. Every other test in the suite
 * exercises `useScreenMotionActive` through `ScreenMotionOverride`, which
 * bypasses this provider entirely - so an inverted boolean or a dropped
 * cleanup here would ship green today. This file is the only coverage of the
 * provider's own state machine.
 *
 * `expo-router`'s real `useFocusEffect` throws outside a navigator, so it is
 * mocked with a controllable double: `require('react').useEffect(effect,
 * [effect])` reproduces the mount-time invocation (matching the pattern in
 * PairingScanScreen.test.tsx and BoardScreen.test.tsx), and the captured
 * `effect` reference lets a test replay a focus event and read back the
 * cleanup a real navigator would run on blur.
 */
const mockLatestFocusEffect: { current: (() => void | (() => void)) | null } = { current: null };

jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    mockLatestFocusEffect.current = effect;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
    require('react').useEffect(effect, [effect]);
  },
}));

function GateReadout(): React.JSX.Element {
  const active = useScreenMotionActive();
  return <Text testID="gate-readout">{active ? 'active' : 'inactive'}</Text>;
}

describe('useScreenMotionActive default (no provider)', () => {
  it('is active outside any provider, so a bare render (every other component test) never turns motion off by accident', () => {
    render(<GateReadout />);
    expect(screen.getByTestId('gate-readout').props.children).toBe('active');
  });
});

describe('ScreenMotionOverride', () => {
  it('drives the gate directly, without a navigator', () => {
    render(
      <ScreenMotionOverride active={false}>
        <GateReadout />
      </ScreenMotionOverride>,
    );
    expect(screen.getByTestId('gate-readout').props.children).toBe('inactive');
  });
});

describe('ScreenMotionProvider', () => {
  beforeEach(() => {
    mockLatestFocusEffect.current = null;
  });

  it('starts active and registers a focus effect with the host navigator', () => {
    render(
      <ScreenMotionProvider>
        <GateReadout />
      </ScreenMotionProvider>,
    );
    expect(screen.getByTestId('gate-readout').props.children).toBe('active');
    expect(mockLatestFocusEffect.current).not.toBeNull();
  });

  /**
   * The mechanism: `useFocusEffect(() => { setFocused(true); return () =>
   * setFocused(false); })`. A real navigator invokes the registered callback
   * on focus and its returned cleanup on blur; this replays both explicitly
   * against the captured callback, the same technique
   * PairingScanScreen.test.tsx uses to replay a focus-regain.
   */
  it('closes the gate when the host navigator blurs the screen, and reopens it on refocus', () => {
    render(
      <ScreenMotionProvider>
        <GateReadout />
      </ScreenMotionProvider>,
    );

    let blurCleanup: (() => void) | undefined;
    act(() => {
      blurCleanup = mockLatestFocusEffect.current?.() ?? undefined;
    });
    expect(blurCleanup).toBeDefined();

    // Blur: the host navigator runs the cleanup the focus callback returned.
    act(() => {
      blurCleanup?.();
    });
    expect(screen.getByTestId('gate-readout').props.children).toBe('inactive');

    // Refocus: the host navigator invokes the focus callback again.
    act(() => {
      mockLatestFocusEffect.current?.();
    });
    expect(screen.getByTestId('gate-readout').props.children).toBe('active');
  });
});
