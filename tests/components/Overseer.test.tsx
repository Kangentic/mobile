import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, Overseer, type OverseerAnimation } from '@/components';
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

function renderOverseer(animate: OverseerAnimation, size = 90): void {
  render(
    <ThemeProvider>
      <Overseer size={size} animate={animate} testID="overseer" />
    </ThemeProvider>,
  );
}

describe('Overseer', () => {
  let randomSpy: jest.SpiedFunction<typeof Math.random>;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('renders the rest frame and swaps to blink and back on the blink loop', () => {
    renderOverseer('blink-loop');
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(HALF_WINDOW_BLINK_DELAY_MS));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(blinkLoop.clip[0].durationMs));
    // 0.5 < 0.3 is false, so the repeat roll declines and the loop restarts.
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    // The loop reschedules: a second blink arrives after another interval.
    act(() => jest.advanceTimersByTime(HALF_WINDOW_BLINK_DELAY_MS));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();
  });

  it('plays a double blink when the repeat roll succeeds, but not a triple', () => {
    // Draw order: idle gap (squared), repeat roll, repeat gap - see the
    // comment in Overseer.tsx pinning this order.
    randomSpy
      .mockReturnValueOnce(0.1) // idle gap: drawn small, arrives quickly
      .mockReturnValueOnce(0.1) // repeat roll: 0.1 < 0.3, triggers the double
      .mockReturnValueOnce(0.5); // repeat gap: midpoint of 270-400ms

    renderOverseer('blink-loop');
    const firstIdleGapMs = blinkIdle.minMs + (blinkIdle.maxMs - blinkIdle.minMs) * 0.1 * 0.1;
    act(() => jest.advanceTimersByTime(firstIdleGapMs));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(blinkLoop.clip[0].durationMs));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    const repeatGapMs = blinkRepeat.gapMinMs + 0.5 * (blinkRepeat.gapMaxMs - blinkRepeat.gapMinMs);
    act(() => jest.advanceTimersByTime(repeatGapMs));
    expect(screen.getByTestId('overseer-frame-blink', HIDDEN)).toBeTruthy();

    // The repeat is gated to once per pass: the second blink's end does not
    // roll again, however long the repeat window is held open for.
    act(() => jest.advanceTimersByTime(blinkLoop.clip[0].durationMs));
    act(() => jest.advanceTimersByTime(blinkRepeat.gapMaxMs));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('overseer-frame-blink', HIDDEN)).toBeNull();
  });

  it('plays the single arm wave (rest, wave, rest, wave, rest) and stops', () => {
    renderOverseer('wave-once');
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    // Advance by the duration of the step being LEFT, not a fixed one: the
    // whole point of the manifest is that upstream can retime any single step
    // without a code change here.
    waveOnce.clip.slice(1).forEach((step, precedingStepIndex) => {
      act(() => jest.advanceTimersByTime(waveOnce.clip[precedingStepIndex].durationMs));
      expect(screen.getByTestId(`overseer-frame-${step.frame}`, HIDDEN)).toBeTruthy();
    });

    // One-shot: no further frame changes however long we wait. The frame alone
    // cannot prove this - wave-once both starts and ends on rest, so a runner
    // that wrongly looped would still be showing rest at most sampled times.
    // The pending-timer count is what actually distinguishes stopped from
    // looping.
    act(() => jest.advanceTimersByTime(blinkIdle.maxMs * 2));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps stepping on the waiting loop (legs never stop)', () => {
    renderOverseer('waiting-loop');
    expect(screen.getByTestId(`overseer-frame-${waitingLoop.clip[0].frame}`, HIDDEN)).toBeTruthy();

    waitingLoop.clip.slice(1).forEach((step, precedingStepIndex) => {
      act(() => jest.advanceTimersByTime(waitingLoop.clip[precedingStepIndex].durationMs));
      expect(screen.getByTestId(`overseer-frame-${step.frame}`, HIDDEN)).toBeTruthy();
    });

    // Loops: the last step's own duration elapses and the clip restarts from
    // its first frame.
    act(() => jest.advanceTimersByTime(waitingLoop.clip[waitingLoop.clip.length - 1].durationMs));
    expect(screen.getByTestId(`overseer-frame-${waitingLoop.clip[0].frame}`, HIDDEN)).toBeTruthy();
  });

  it('cancels its pending frame timer on unmount', () => {
    const { unmount } = render(
      <ThemeProvider>
        <Overseer size={90} animate="waiting-loop" testID="overseer" />
      </ThemeProvider>,
    );
    // waiting-loop has no idle gap, so a clip timer is always pending.
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('drops the outgoing animation timer when animate changes mid-clip', () => {
    const { rerender } = render(
      <ThemeProvider>
        <Overseer size={90} animate="waiting-loop" testID="overseer" />
      </ThemeProvider>,
    );
    const [firstStep, secondStep] = waitingLoop.clip;
    expect(screen.getByTestId(`overseer-frame-${firstStep.frame}`, HIDDEN)).toBeTruthy();

    // Swap before the first step elapses. The stale timer must not survive to
    // advance the retired sequence's frame.
    rerender(
      <ThemeProvider>
        <Overseer size={90} animate="blink-loop" testID="overseer" />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(firstStep.durationMs));
    expect(screen.queryByTestId(`overseer-frame-${secondStep.frame}`, HIDDEN)).toBeNull();
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
  });

  it('rests on the rest frame under OS reduced motion', () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);

    renderOverseer('blink-loop');
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();

    act(() => jest.advanceTimersByTime(blinkIdle.maxMs * 2));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
    expect(screen.queryByTestId('overseer-frame-blink', HIDDEN)).toBeNull();
  });

  it('does not animate when animate is none', () => {
    renderOverseer('none');
    act(() => jest.advanceTimersByTime(blinkIdle.maxMs * 2));
    expect(screen.getByTestId('overseer-frame-rest', HIDDEN)).toBeTruthy();
  });

  it('snaps the requested size down to an integer pixel scale', () => {
    // 100dp over an 18-column grid floors to a 5dp pixel: 90 wide, 60 tall.
    renderOverseer('none', 100);
    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('overseer', HIDDEN).props.style);
    expect(flattenedStyle.width).toBe(90);
    expect(flattenedStyle.height).toBe(60);
  });
});
