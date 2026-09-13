import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { NOW_TICK_MS, NowTickProvider, ThemeProvider } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';
import { WaitLabel } from '@/components/board/WaitLabel';
import { getRetentionProbeVariant, type RetentionProbeVariant } from '@/devsupport/retentionProbe';

const MINUTE = 60_000;

/**
 * `NowTick.tsx` reads `useScreenFocusActive`, deliberately NOT
 * `useScreenMotionActive` - the two hooks are identical except for the
 * retention-probe override, so a `no-motion` probe run must not freeze
 * elapsed times during the very measurement it is running. Typed from the
 * real export rather than re-spelled, so a renamed variant breaks this mock
 * instead of quietly drifting (the pattern `SettingsScreen.test.tsx` already
 * uses for its own retention-probe-adjacent mocks). Type-only imports are
 * erased, so this does not defeat the jest.mock below.
 */
const mockGetRetentionProbeVariant = jest.fn<RetentionProbeVariant, []>().mockReturnValue('off');
jest.mock('@/devsupport/retentionProbe', () => ({
  getRetentionProbeVariant: () => mockGetRetentionProbeVariant(),
}));

describe('NowTick reads focus, not motion', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
    mockGetRetentionProbeVariant.mockReturnValue('no-motion');
  });

  afterEach(() => {
    jest.useRealTimers();
    mockGetRetentionProbeVariant.mockReturnValue('off');
  });

  it('keeps advancing under the no-motion retention probe on a focused screen', () => {
    // Guards against a silently-dead mock: this imports the SAME named
    // export ScreenMotion.tsx imports, through the SAME module specifier
    // jest.mock above targets. If that mock never actually intercepted the
    // real module, `probeEnabled` would read the (unset) env flag and this
    // would report 'off' regardless of `mockGetRetentionProbeVariant`'s own
    // return value - exactly the dead-mock failure this test exists to
    // catch, so it proves the wiring before trusting the rest of the test.
    expect(getRetentionProbeVariant()).toBe('no-motion');

    render(
      <ThemeProvider>
        <ScreenMotionOverride active>
          <NowTickProvider enabled>
            <WaitLabel sinceMs={Date.now() - 12 * MINUTE} testID="wait" />
          </NowTickProvider>
        </ScreenMotionOverride>
      </ThemeProvider>,
    );

    expect(screen.getByTestId('wait')).toHaveTextContent('12m');

    act(() => {
      jest.advanceTimersByTime(NOW_TICK_MS * 2);
    });

    // If NowTick read useScreenMotionActive instead, the no-motion override
    // above would force `focused` false regardless of the real ScreenMotion
    // context value, `running` would be false, and this would still read
    // '12m' - frozen, which a plain periodic clock must never be under the
    // probe (see NowTick.tsx's docstring on why it uses the focus hook).
    expect(screen.getByTestId('wait')).toHaveTextContent('13m');
  });
});

/**
 * The resume-refresh: `NowTickProvider`'s effect also schedules
 * `setTimeout(refresh, 0)` on mount/resume, so a screen returned to after a
 * long blur catches up immediately rather than waiting for the next 30s
 * tick. Deleting that line is invisible to every other WaitLabel/NowTick
 * test, none of which re-focus after a blur.
 */
describe('NowTick catches up on resume', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows the caught-up elapsed time on refocus, without waiting for the next 30s tick', () => {
    const HOUR_MS = 60 * MINUTE;
    // Computed once, before any clock advance, and reused as the same
    // literal in every render below - `sinceMs` must NOT track "now", or a
    // re-render after advancing the clock would read as still-correct with
    // no resume timer involved at all.
    const waitingSinceMs = Date.now() - 12 * MINUTE;

    function tree(focused: boolean): React.JSX.Element {
      return (
        <ThemeProvider>
          <ScreenMotionOverride active={focused}>
            <NowTickProvider enabled>
              <WaitLabel sinceMs={waitingSinceMs} testID="wait" />
            </NowTickProvider>
          </ScreenMotionOverride>
        </ThemeProvider>
      );
    }

    const view = render(tree(true));
    expect(screen.getByTestId('wait')).toHaveTextContent('12m');

    // Blur, then let an hour pass while covered - the label must not move
    // (covered by WaitLabel.test.tsx's 'stops ticking while the screen is
    // blurred'; this is only the setup for the resume this test pins).
    act(() => {
      view.rerender(tree(false));
    });
    act(() => {
      jest.advanceTimersByTime(HOUR_MS);
    });
    expect(screen.getByTestId('wait')).toHaveTextContent('12m');

    // Refocus, then flush ONLY the zero-delay resume timer - deliberately
    // not a further NOW_TICK_MS advance, which would let the periodic
    // interval do the work the resume timer is supposed to do instead.
    act(() => {
      view.rerender(tree(true));
    });
    act(() => {
      jest.advanceTimersByTime(0);
    });

    expect(screen.getByTestId('wait')).toHaveTextContent('1h 12m');
  });
});
