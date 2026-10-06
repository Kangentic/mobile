import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, Overseer, type OverseerAnimation } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import { overseerSequences } from '@/brand/overseerFrames.generated';

const blinkLoop = overseerSequences['blink-loop'];
const waveOnce = overseerSequences['wave-once'];
const waitingLoop = overseerSequences['waiting-loop'];

const blinkIdle = blinkLoop.idle;
const blinkRepeat = blinkLoop.repeat;
// idle and repeat are optional on the generated type, and these tests are
// specifically about the idle gap and the double-blink reroll. Say so here:
// a branding bump that drops either field should name the assumption it broke,
// not crash every test in the file on an undefined property read.
if (blinkIdle === undefined || blinkRepeat === undefined) {
  throw new Error('blink-loop must declare both idle and repeat; @kangentic/branding changed its motion manifest');
}

/** With Math.random pinned to 0.5, bias: "square" draws min + (max - min) * 0.5^2. */
const HALF_WINDOW_BLINK_DELAY_MS = blinkIdle.minMs + (blinkIdle.maxMs - blinkIdle.minMs) * 0.5 * 0.5;

// The mascot subtree is deliberately hidden from accessibility (decorative
// art), which also hides it from default RNTL queries.
const HIDDEN = { includeHiddenElements: true } as const;

async function renderOverseer(animate: OverseerAnimation, size = 90): Promise<void> {
  await render(
    <ThemeProvider>
      <Overseer size={size} animate={animate} testID="overseer" />
    </ThemeProvider>,
  );
}

describe('Overseer', () => {
  let randomSpy: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    // RNTL 14 awaits React's act, which schedules its flush with queueMicrotask.
    // Faked, those jobs sit on the fake clock and jest.getTimerCount() counts
    // them. Leave queueMicrotask real so the assertions below count the
    // mascot's own frame timer alone.
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders the rest frame and swaps to blink and back on the blink loop', async () => {
    await renderOverseer('blink-loop');
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    await act(() => jest.advanceTimersByTime(HALF_WINDOW_BLINK_DELAY_MS));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();

    await act(() => jest.advanceTimersByTime(blinkLoop.clip[0].durationMs));
    // 0.5 < 0.3 is false, so the repeat roll declines and the loop restarts.
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    // The loop reschedules: a second blink arrives after another interval.
    await act(() => jest.advanceTimersByTime(HALF_WINDOW_BLINK_DELAY_MS));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();
  });

  it('plays a double blink when the repeat roll succeeds, but not a triple', async () => {
    // Draw order: idle gap (squared), repeat roll, repeat gap - see the
    // comment in Overseer.tsx pinning this order.
    randomSpy
      .mockReturnValueOnce(0.1) // idle gap: drawn small, arrives quickly
      .mockReturnValueOnce(0.1) // repeat roll: 0.1 < 0.3, triggers the double
      .mockReturnValueOnce(0.5); // repeat gap: midpoint of 270-400ms

    await renderOverseer('blink-loop');
    const firstIdleGapMs = blinkIdle.minMs + (blinkIdle.maxMs - blinkIdle.minMs) * 0.1 * 0.1;
    await act(() => jest.advanceTimersByTime(firstIdleGapMs));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();

    await act(() => jest.advanceTimersByTime(blinkLoop.clip[0].durationMs));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    const repeatGapMs = blinkRepeat.gapMinMs + 0.5 * (blinkRepeat.gapMaxMs - blinkRepeat.gapMinMs);
    await act(() => jest.advanceTimersByTime(repeatGapMs));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();

    // The repeat is gated to once per pass: the second blink's end does not
    // roll again, however long the repeat window is held open for.
    await act(() => jest.advanceTimersByTime(blinkLoop.clip[0].durationMs));
    await act(() => jest.advanceTimersByTime(blinkRepeat.gapMaxMs));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('overseer-frame-blink', HIDDEN)).toBeNull();
  });

  it('plays the single arm wave (rest, wave, rest, wave, rest) and stops', async () => {
    await renderOverseer('wave-once');
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    // Advance by the duration of the step being LEFT, not a fixed one: the
    // whole point of the manifest is that upstream can retime any single step
    // without a code change here.
    for (const [precedingStepIndex, step] of waveOnce.clip.slice(1).entries()) {
      await act(() => jest.advanceTimersByTime(waveOnce.clip[precedingStepIndex].durationMs));
      expect(screen.getByTestId(`overseer-frame-${step.frame}`, HIDDEN)).toBeTruthy();
    }

    // One-shot: no further frame changes however long we wait. The frame alone
    // cannot prove this - wave-once both starts and ends on rest, so a runner
    // that wrongly looped would still be showing rest at most sampled times.
    // The pending-timer count is what actually distinguishes stopped from
    // looping.
    await act(() => jest.advanceTimersByTime(blinkIdle.maxMs * 2));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps stepping on the waiting loop (legs never stop)', async () => {
    await renderOverseer('waiting-loop');
    expect(screen.getByTestId(`overseer-frame-${waitingLoop.clip[0].frame}`, HIDDEN)).toBeTruthy();

    for (const [precedingStepIndex, step] of waitingLoop.clip.slice(1).entries()) {
      await act(() => jest.advanceTimersByTime(waitingLoop.clip[precedingStepIndex].durationMs));
      expect(screen.getByTestId(`overseer-frame-${step.frame}`, HIDDEN)).toBeTruthy();
    }

    // Loops: the last step's own duration elapses and the clip restarts from
    // its first frame.
    await act(() => jest.advanceTimersByTime(waitingLoop.clip[waitingLoop.clip.length - 1].durationMs));
    expect(screen.getByTestId(`overseer-frame-${waitingLoop.clip[0].frame}`, HIDDEN)).toBeTruthy();
  });

  it('cancels its pending frame timer on unmount', async () => {
    const { unmount } = await render(
      <ThemeProvider>
        <Overseer size={90} animate="waiting-loop" testID="overseer" />
      </ThemeProvider>,
    );
    // waiting-loop has no idle gap, so a clip timer is always pending.
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    await unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('drops the outgoing animation timer when animate changes mid-clip', async () => {
    const { rerender } = await render(
      <ThemeProvider>
        <Overseer size={90} animate="waiting-loop" testID="overseer" />
      </ThemeProvider>,
    );
    const [firstStep, secondStep] = waitingLoop.clip;
    expect(screen.getByTestId(`overseer-frame-${firstStep.frame}`, HIDDEN)).toBeTruthy();

    // Swap before the first step elapses. The stale timer must not survive to
    // advance the retired sequence's frame.
    await rerender(
      <ThemeProvider>
        <Overseer size={90} animate="blink-loop" testID="overseer" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    await act(() => jest.advanceTimersByTime(firstStep.durationMs));
    expect(screen.queryByTestId(`overseer-frame-${secondStep.frame}`, HIDDEN)).toBeNull();
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
  });

  it('rests on the rest frame under OS reduced motion', async () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);

    await renderOverseer('blink-loop');
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    await act(() => jest.advanceTimersByTime(blinkIdle.maxMs * 2));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('overseer-frame-blink', HIDDEN)).toBeNull();
  });

  it('does not animate when animate is none', async () => {
    await renderOverseer('none');
    await act(() => jest.advanceTimersByTime(blinkIdle.maxMs * 2));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
  });

  it('snaps the requested size down to an integer pixel scale', async () => {
    // 100dp over an 18-column grid floors to a 5dp pixel: 90 wide, 60 tall.
    await renderOverseer('none', 100);
    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('overseer', HIDDEN).props.style);
    expect(flattenedStyle.width).toBe(90);
    expect(flattenedStyle.height).toBe(60);
  });

  /**
   * The mascot is the one looping-motion component that was missing the screen
   * focus gate `AgentStatusIcon` and `Skeleton` already use, so it kept
   * re-rendering its ~35-View grid while a pushed route covered it. Gated now
   * on `useScreenMotionActive()`.
   *
   * `waiting-loop` is used because it has no idle gap: a running mascot ALWAYS
   * has a clip timer pending, so the pending-timer count is the mechanism
   * assertion. The frame alone cannot prove it - waiting-loop's first frame is
   * not the rest frame, so a wrongly-running mascot and a correctly-rested one
   * differ in frame immediately, but a test that only sampled a frame at one
   * instant could still be fooled by timing; the timer count cannot.
   */
  describe('the screen motion gate', () => {
    async function renderGated(active: boolean, animate: OverseerAnimation): Promise<void> {
      await render(
        <ThemeProvider>
          <ScreenMotionOverride active={active}>
            <Overseer size={90} animate={animate} testID="overseer" />
          </ScreenMotionOverride>
        </ThemeProvider>,
      );
    }

    it('rests on the rest frame and schedules no timer while the screen is blurred', async () => {
      await renderGated(false, 'waiting-loop');
      expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
      expect(jest.getTimerCount()).toBe(0);

      // And it stays rested however long the loop would otherwise run for.
      await act(() => jest.advanceTimersByTime(waitingLoop.clip[0].durationMs * 4));
      expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
    });

    it('animates when the gate is active, so the gate cannot silently freeze the mascot', async () => {
      await renderGated(true, 'waiting-loop');
      expect(screen.getByTestId(`overseer-frame-${waitingLoop.clip[0].frame}`, HIDDEN)).toBeTruthy();
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    });
  });
});
