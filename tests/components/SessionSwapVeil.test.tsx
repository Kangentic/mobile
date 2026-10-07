import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import type { TestInstance } from 'test-renderer';
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
 * Every rendered Text host. RNTL 14 renders host elements only, so the old
 * `UNSAFE_queryAllByType(Text)` (a composite-component query, removed in v14)
 * becomes a query on the host type name: both react-native's Text and
 * Animated.Text render the host 'Text' element in this Jest environment, and
 * nothing at all can render a bare string outside one (v14 throws on that).
 */
function renderedTextHosts(): TestInstance[] {
  return screen.container.queryAll((node) => node.type === 'Text');
}

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
  it('renders no text at all', async () => {
    await render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
    expect(renderedTextHosts()).toHaveLength(0);
  });

  /**
   * The control for the two no-text assertions: if the host type name ever
   * stopped being 'Text' in this environment, `toHaveLength(0)` would pass on
   * a veil that grew a caption. This is what proves the query can see one.
   */
  it('finds a rendered Text host, so the no-text assertions can fail', async () => {
    await render(<Text>caption</Text>);

    expect(renderedTextHosts()).toHaveLength(1);
  });

  it('is one modal, busy progress stop for a screen reader, with a descriptive label', async () => {
    await render(
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
  it('keeps its root tappable so the covered pane cannot be reached', async () => {
    await render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-swap-veil').props.pointerEvents).not.toBe('none');
  });

  /**
   * The veil mounts already opaque: no entering animation on its root. A fade
   * in starts at opacity 0, and the native view keeps that first write until a
   * frame advances it (the last-write-wins class motion-conventions.md records).
   * On PR #103's paired E2E run (37559159800) that happened. Maestro found the
   * root mounted at the full pane box but `visible: false` on all 36 polls over
   * 5.6 s, while the panes beside it were visible. So a surface whose one job is
   * to cover a session that just ended was in the tree and invisible. Nothing
   * about covering may depend on a frame arriving. The exit keeps its crossfade:
   * a stuck exit leaves the veil up rather than missing, and its fade was chosen
   * because the bare cut read badly at the reveal.
   *
   * The second expectation is the control: it proves this environment's
   * Reanimated mock exposes layout-animation props on the host at all, so the
   * first cannot pass merely because the mock strips them.
   *
   * Mutation seen failing: putting `entering={presets.crossfadeIn}` back on the
   * root (with the preset restored) fails the first expectation.
   */
  it('mounts already opaque, with no entering animation, and keeps its exit crossfade', async () => {
    await render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const veil = screen.getByTestId('session-swap-veil');
    expect(veil.props.entering).toBeUndefined();
    expect(veil.props.exiting).toBeDefined();
  });

  /** Above the panes' zIndex: 1, the same stacking pin the two text overlays carry. */
  it('stacks above the session panes', async () => {
    await render(
      <ThemeProvider>
        <SessionSwapVeil />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil').props.style);
    expect(typeof flattenedStyle.zIndex).toBe('number');
    expect(flattenedStyle.zIndex).toBeGreaterThanOrEqual(2);
  });

  it('starts the pulse at the max opacity over the theme background when motion is allowed', async () => {
    await render(
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
   * its scrim in place of the dead session's last frame, the scrim held
   * STILL, a cursor breathing above it at the grid's origin, the waiting
   * label, and still nothing to read. The desktop's launch overlay is a
   * spinner over a blank terminal area; this is the terminal's own version.
   */
  describe('the waiting phase', () => {
    it('paints the empty terminal under a static scrim with a cursor above it, and still renders no text', async () => {
      await render(
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
      // Painted in this order: the empty terminal, the scrim that dims it,
      // then the cursor ABOVE the scrim so the scrim does not dim it away.
      const layerOrder = veil.children.map((child) => (typeof child === 'string' ? child : child.props.testID));
      expect(layerOrder).toEqual(['session-swap-veil-empty', 'session-swap-veil-scrim', 'session-swap-veil-cursor']);
      const cursorStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style);
      expect(cursorStyle.backgroundColor).toBe(darkTerminalTheme.colors.textSecondary);
      expect(cursorStyle.opacity).toBe(darkTerminalTheme.motion.waitCursorBlink.opacityMax);
      expect(renderedTextHosts()).toHaveLength(0);
    });

    /**
     * The performance finding behind the cursor's shape, measured on the
     * release build (emulator, 2026-09-18): a tweened breath on the
     * cell-sized cursor drew a whole window frame per vsync (57 a second at
     * 24-28% of a core), the same cost the full-screen scrim breath had,
     * while the identical veil held still drew nothing (1.5-4%). A frame
     * costs what it costs however small the
     * view that changed. So once the pane has cleared the scrim is the static
     * branch and the cursor is a two-state toggle on a JS interval: NO
     * Reanimated mapper in the waiting phase at all, one commit per
     * half-period, lit then dim.
     */
    it('holds the scrim static once cleared, registers no mapper, and blinks the cursor on the interval', async () => {
      jest.useFakeTimers();
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
      const { intervalMs, opacityMin: cursorMin, opacityMax: cursorMax } = darkTerminalTheme.motion.waitCursorBlink;

      try {
        await render(
          <ThemeProvider>
            <ScreenMotionOverride active={true}>
              <SessionSwapVeil waiting />
            </ScreenMotionOverride>
          </ThemeProvider>,
        );

        const scrimStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
        expect(scrimStyle.opacity).toBe((opacityMin + opacityMax) / 2);
        expect(animatedStyleSpy).not.toHaveBeenCalled();

        const cursorOpacity = (): number =>
          StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style).opacity as number;
        expect(cursorOpacity()).toBe(cursorMax);
        await act(() => {
          jest.advanceTimersByTime(intervalMs);
        });
        expect(cursorOpacity()).toBe(cursorMin);
        await act(() => {
          jest.advanceTimersByTime(intervalMs);
        });
        expect(cursorOpacity()).toBe(cursorMax);
      } finally {
        jest.useRealTimers();
      }
    });

    it('rests the cursor at its mid opacity, never toggling, under OS reduced motion', async () => {
      jest.useFakeTimers();
      jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');
      const { intervalMs, opacityMin: cursorMin, opacityMax: cursorMax } = darkTerminalTheme.motion.waitCursorBlink;

      try {
        await render(
          <ThemeProvider>
            <SessionSwapVeil waiting />
          </ThemeProvider>,
        );

        const cursorOpacity = (): number =>
          StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style).opacity as number;
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
        await act(() => {
          jest.advanceTimersByTime(intervalMs * 2);
        });
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
        expect(animatedStyleSpy).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('rests the cursor at its mid opacity, never toggling, while the screen is blurred', async () => {
      jest.useFakeTimers();
      const { intervalMs, opacityMin: cursorMin, opacityMax: cursorMax } = darkTerminalTheme.motion.waitCursorBlink;

      try {
        await render(
          <ThemeProvider>
            <ScreenMotionOverride active={false}>
              <SessionSwapVeil waiting />
            </ScreenMotionOverride>
          </ThemeProvider>,
        );

        const cursorOpacity = (): number =>
          StyleSheet.flatten(screen.getByTestId('session-swap-veil-cursor').props.style).opacity as number;
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
        await act(() => {
          jest.advanceTimersByTime(intervalMs * 2);
        });
        expect(cursorOpacity()).toBe((cursorMin + cursorMax) / 2);
      } finally {
        jest.useRealTimers();
      }
    });

    it('paints no empty layer and no cursor through the quiet phase, where the last frame is the point', async () => {
      await render(
        <ThemeProvider>
          <SessionSwapVeil />
        </ThemeProvider>,
      );

      expect(screen.queryByTestId('session-swap-veil-empty')).toBeNull();
      expect(screen.queryByTestId('session-swap-veil-cursor')).toBeNull();
      expect(screen.getByTestId('session-swap-veil').props.accessibilityLabel).toBe(
        SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
      );
    });
  });

  /**
   * The mechanism assertion, copied from Skeleton's motion-gate block: a veil
   * that never animates still renders a correct-looking static scrim, so the
   * rendered output cannot tell a gated pulse from a mapper silently
   * registered behind it. On Reanimated 4.5.1 the per-vsync flush walked
   * every REGISTERED mapper, dirty or not (~0.47 CPU points each, measured on
   * a release build; 4.7.1 measures them free), and a mapper's writes outlive
   * its view's rebind, so the hooks live in the child that is mounted only on
   * the animating branch.
   */
  describe('the motion gate', () => {
    it('rests at the mid opacity and registers no animated mapper under OS reduced motion', async () => {
      jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      await render(
        <ThemeProvider>
          <SessionSwapVeil />
        </ThemeProvider>,
      );

      const flattenedStyle = StyleSheet.flatten(screen.getByTestId('session-swap-veil-scrim').props.style);
      expect(flattenedStyle.opacity).toBe((opacityMin + opacityMax) / 2);
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    it('rests at the mid opacity and registers no animated mapper while the screen is blurred', async () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      await render(
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

    it('registers exactly one animated mapper once the screen is focused', async () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      await render(
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
