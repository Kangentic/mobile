import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, darkTerminalTheme } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import {
  SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
  SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL,
  SessionSwapVeil,
} from '@/screens/task/SessionSwapVeil';

const { opacityMin, opacityMax } = darkTerminalTheme.motion.swapVeilPulse;

/**
 * The veil's own contract: silent, covering, breathing only when motion is
 * allowed. What OPENS and RELEASES it is SessionScreen's, pinned in
 * SessionScreen.session-swap.test.tsx.
 */
describe('SessionSwapVeil', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * The whole ask: nothing to read. A caption or title added "for clarity"
   * would pass every other test here and fail exactly this one.
   */
  it('renders no text at all', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
    expect(screen.UNSAFE_queryAllByType(Text)).toHaveLength(0);
  });

  it('is one modal, busy progress stop for a screen reader, with a descriptive label', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const veil = screen.getByTestId('session-swap-veil');
    expect(veil.props.accessibilityViewIsModal).toBe(true);
    expect(veil.props.accessibilityRole).toBe('progressbar');
    expect(veil.props.accessibilityLabel).toBe(SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL);
    expect(veil.props.accessibilityState).toEqual({ busy: true });
  });

  /**
   * The veil must swallow a tap on the covered pane (a tap on the terminal
   * WebView toggles the keyboard for a dead PTY), so its root keeps the
   * default pointer behaviour. `pointerEvents="none"` on the root would look
   * harmless and let taps fall through.
   */
  it('keeps its root tappable so the covered pane cannot be reached', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-swap-veil').props.pointerEvents).not.toBe('none');
  });

  /** Above the panes' zIndex: 1, the same stacking pin the two text overlays carry. */
  it('stacks above the session panes', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil').props.style);
    expect(typeof flattenedStyle.zIndex).toBe('number');
    expect(flattenedStyle.zIndex).toBeGreaterThanOrEqual(2);
  });

  it('starts the pulse at the max opacity over the theme background when motion is allowed', () => {
    render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
    expect(flattenedStyle.opacity).toBe(opacityMax);
    expect(flattenedStyle.backgroundColor).toBe(darkTerminalTheme.colors.background);
  });

  /**
   * The waiting phase: the same veil, with the empty terminal painted UNDER
   * its scrim in place of the dead session's last frame, the waiting label,
   * and still nothing to read. The desktop's launch overlay is a spinner
   * over a blank terminal area; this is the phone's version of blank.
   */
  describe('the waiting phase', () => {
    it('paints the empty terminal under the scrim, carries the waiting label, and still renders no text', () => {
      render(
        <ThemeProvider>
          <SessionSwapVeil waiting />
        </ThemeProvider>,
      );

      const veil = screen.getByTestId('session-swap-veil');
      expect(veil.props.accessibilityLabel).toBe(SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL);
      const emptyLayer = screen.getByTestId('session-swap-veil-empty');
      expect(StyleSheet.flatten(emptyLayer.props.style).backgroundColor).toBe(
        darkTerminalTheme.colors.terminalBackground,
      );
      expect(emptyLayer.props.pointerEvents).toBe('none');
      // Painted BEFORE the scrim, so the scrim dims the empty terminal and
      // not the other way round.
      const layerOrder = veil.children.map((child) => (typeof child === 'string' ? child : child.props.testID));
      expect(layerOrder).toEqual(['session-swap-veil-empty', 'session-swap-veil-scrim']);
      expect(screen.UNSAFE_queryAllByType(Text)).toHaveLength(0);
    });

    it('paints no empty layer through the quiet phase, where the last frame is the point', () => {
      render(
        <ThemeProvider>
          <SessionSwapVeil />
        </ThemeProvider>,
      );

      expect(screen.queryByTestId('session-swap-veil-empty')).toBeNull();
      expect(screen.getByTestId('session-swap-veil').props.accessibilityLabel).toBe(
        SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
      );
    });
  });

  /**
   * The mechanism assertion, copied from Skeleton's motion-gate block: a veil
   * that never animates still renders a correct-looking static scrim, so the
   * rendered output cannot tell a gated pulse from a mapper silently
   * registered behind it. The per-vsync Reanimated flush walks every
   * REGISTERED mapper, dirty or not (~0.47 CPU points each, measured on a
   * release build), so the hooks must live in the child that is mounted
   * only on the animating branch.
   */
  describe('the motion gate', () => {
    it('rests at the mid opacity and registers no animated mapper under OS reduced motion', () => {
      jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <SessionSwapVeil />
        </ThemeProvider>,
      );

      const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
      expect(flattenedStyle.opacity).toBe((opacityMin + opacityMax) / 2);
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    it('rests at the mid opacity and registers no animated mapper while the screen is blurred', () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <ScreenMotionOverride active={false}>
            <SessionSwapVeil />
          </ScreenMotionOverride>
        </ThemeProvider>,
      );

      const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
      expect(flattenedStyle.opacity).toBe((opacityMin + opacityMax) / 2);
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    it('registers exactly one animated mapper once the screen is focused', () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <ScreenMotionOverride active={true}>
            <SessionSwapVeil />
          </ScreenMotionOverride>
        </ThemeProvider>,
      );

      expect(animatedStyleSpy).toHaveBeenCalledTimes(1);
    });
  });
});
