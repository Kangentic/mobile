import React from 'react';
import { View } from 'react-native';
import { act, cleanup, render, screen } from '@testing-library/react-native';
import { MapperLoad } from '@/devsupport/MapperLoad';
import { retentionProbeEnabled, setRetentionProbeVariant } from '@/devsupport/retentionProbe';

/**
 * `MapperLoad` is the `extra-mappers` arm of the retention probe: a dev-support
 * tool, never shipped behaviour. It earns a test anyway because its whole value
 * is a MEASUREMENT, and it has already voided one. It used to read the variant
 * at render time, so on 2026-10-06 a switch reached only the one memoized row
 * that happened to re-render, the arm mounted 8 mapper units instead of the
 * list's 64, and the CPU reading taken from it meant nothing. The fix was to
 * subscribe, and to log what actually mounted so an arm is checked before its
 * CPU is read. These tests pin exactly those two things, plus the gate that
 * keeps both out of a build with no probe flag.
 *
 * The real `retentionProbe` module is used, not a stand-in: the flag is read
 * once at its import, so the factory below sets it first, and the subscription
 * under test is the module's own listener set.
 */
jest.mock('@/devsupport/retentionProbe', () => {
  process.env.EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE = '1';
  return jest.requireActual<typeof import('@/devsupport/retentionProbe')>('@/devsupport/retentionProbe');
});

// `traceConnection` is gated on its own env flag and writes to the console, so
// it is replaced by a spy: the log line IS the probe's output.
const mockTraceConnection = jest.fn();
jest.mock('@/devsupport/connectionTrace', () => ({
  traceConnection: (event: string, fields?: Record<string, string | number | boolean | null>) =>
    mockTraceConnection(event, fields),
}));

/** Mounted units per MapperLoad under the extra-mappers variant. */
const UNITS_PER_ROW = 8;
const REPORT_DEBOUNCE_MS = 500;

/**
 * Stands in for a memoized feed row: it takes no props, so nothing ever
 * re-renders it from above. The only way a variant switch can reach the
 * MapperLoad inside is the MapperLoad's own subscription, which is the
 * property the original bug lacked.
 */
const MemoizedRow = React.memo(function MemoizedRow(): React.JSX.Element {
  return (
    <View testID="row">
      <MapperLoad />
    </View>
  );
});

describe('MapperLoad', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockTraceConnection.mockClear();
    // Nothing is mounted between tests, so this notifies no subscriber.
    setRetentionProbeVariant('off');
  });

  afterEach(async () => {
    // Unmount first, while the fake timers are still installed, so the
    // unmount's own debounce timer is one this test can discard.
    await cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('is running against the real probe module with the flag on', () => {
    // Guards against a dead factory: if the flag never took, every test below
    // would exercise the inert branch and pass or fail for the wrong reason.
    expect(retentionProbeEnabled()).toBe(true);
  });

  it('mounts nothing and logs nothing while the variant is off', async () => {
    await render(<MemoizedRow />);
    await act(() => {
      jest.advanceTimersByTime(REPORT_DEBOUNCE_MS * 2);
    });

    expect(screen.getByTestId('row').children).toHaveLength(0);
    expect(mockTraceConnection).not.toHaveBeenCalled();
  });

  it('reaches memoized rows on a variant switch and logs the settled count once', async () => {
    await render(
      <>
        <MemoizedRow />
        <MemoizedRow />
      </>,
    );
    expect(mockTraceConnection).not.toHaveBeenCalled();

    // No re-render from above: the switch can only arrive by subscription.
    await act(() => {
      setRetentionProbeVariant('extra-mappers');
    });
    const rowChildCounts = screen.getAllByTestId('row').map((row) => row.children.length);
    expect(rowChildCounts).toEqual([UNITS_PER_ROW, UNITS_PER_ROW]);

    // Held back until the count has been still for the whole debounce window.
    await act(() => {
      jest.advanceTimersByTime(REPORT_DEBOUNCE_MS - 1);
    });
    expect(mockTraceConnection).not.toHaveBeenCalled();

    await act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockTraceConnection).toHaveBeenCalledTimes(1);
    expect(mockTraceConnection).toHaveBeenCalledWith('mapper-load', { mounted: UNITS_PER_ROW * 2 });
  });

  it('restarts the debounce on every change, so a list that mounts in stages logs one settled count', async () => {
    await act(() => {
      setRetentionProbeVariant('extra-mappers');
    });
    await render(<MemoizedRow />);
    await act(() => {
      jest.advanceTimersByTime(REPORT_DEBOUNCE_MS - 200);
    });

    // A second row arrives partway through the window, so the window restarts.
    await render(<MemoizedRow />);
    await act(() => {
      jest.advanceTimersByTime(REPORT_DEBOUNCE_MS - 1);
    });
    expect(mockTraceConnection).not.toHaveBeenCalled();

    await act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(mockTraceConnection).toHaveBeenCalledTimes(1);
    expect(mockTraceConnection).toHaveBeenCalledWith('mapper-load', { mounted: UNITS_PER_ROW * 2 });
  });

  it('counts units back down when the variant is switched off, so a stale arm cannot read as loaded', async () => {
    await render(<MemoizedRow />);
    await act(() => {
      setRetentionProbeVariant('extra-mappers');
    });
    await act(() => {
      jest.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    });
    expect(mockTraceConnection).toHaveBeenLastCalledWith('mapper-load', { mounted: UNITS_PER_ROW });

    await act(() => {
      setRetentionProbeVariant('off');
    });
    expect(screen.getByTestId('row').children).toHaveLength(0);
    await act(() => {
      jest.advanceTimersByTime(REPORT_DEBOUNCE_MS);
    });
    expect(mockTraceConnection).toHaveBeenCalledTimes(2);
    expect(mockTraceConnection).toHaveBeenLastCalledWith('mapper-load', { mounted: 0 });
  });
});

// Last in the file on purpose: the registry reset and `jest.doMock` below change
// what every later `require` in this file loads, so a test added after it would
// get the inert probe and a second copy of React.
describe('MapperLoad without the probe flag', () => {
  it('is a plain null component that never touches the subscription', () => {
    const mockUseRetentionProbeVariant = jest.fn(() => {
      throw new Error('subscribed to the retention probe in a build without the flag');
    });
    // The flag is read once, when MapperLoad is imported, so the inert branch
    // needs its own import with the probe reporting itself off. The registry is
    // reset (isolateModules would not do: it reuses the mock instance the import
    // at the top of this file already created). The component is then CALLED
    // rather than rendered: the reset module graph carries its own copy of
    // React, and a hook call outside a render throws, which is the signal that
    // the shipped path calls none.
    jest.resetModules();
    jest.doMock('@/devsupport/retentionProbe', () => ({
      retentionProbeEnabled: () => false,
      useRetentionProbeVariant: mockUseRetentionProbeVariant,
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the module under test must load after the registry reset
    const inertModule = require('@/devsupport/MapperLoad') as typeof import('@/devsupport/MapperLoad');

    expect(inertModule.MapperLoad()).toBeNull();
    expect(mockUseRetentionProbeVariant).not.toHaveBeenCalled();
  });
});
