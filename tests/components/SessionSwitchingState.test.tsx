import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionSwitchingState } from '@/screens/task/SessionSwitchingState';

/**
 * Props-level coverage of the switching-state overlay: which button fires,
 * and which `label` values render versus fall back to the generic caption.
 * The signal that decides WHEN this overlay shows (a column move OR a
 * desktop spawnProgressLabel, kangentic board #639) lives in SessionScreen
 * and is locked by SessionScreen.session-swap.test.tsx; this suite only
 * pins the overlay's own contract.
 */
describe('SessionSwitchingState', () => {
  it('renders the title, a short label, and fires onViewChanges', () => {
    const onViewChanges = jest.fn();
    render(
      <ThemeProvider>
        <SessionSwitchingState onViewChanges={onViewChanges} label="Switching model..." />
      </ThemeProvider>,
    );

    expect(screen.getByText('Switching session')).toBeTruthy();
    expect(screen.getByText('Switching model...')).toBeTruthy();

    fireEvent.press(screen.getByTestId('session-switching-view-changes'));
    expect(onViewChanges).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no label at all', undefined],
    ['a null label', null],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
    ['a string carrying a newline', 'Switching model...\n(waiting 12s)'],
    ['a string carrying a carriage return', 'Switching model...\r(waiting 12s)'],
    // U+2028 and U+2029 break a line in RN's Text just like \n, but trim()
    // treats them as line terminators and strips them only at the ends, so an
    // INTERIOR one clears every other check in renderableSpawnLabel.
    ['a string carrying a U+2028 line separator', 'Switching model... (waiting 12s)'],
    ['a string carrying a U+2029 paragraph separator', 'Switching model... (waiting 12s)'],
    ['a string over the one-line cap', 'A'.repeat(46)],
  ])('falls back to the generic caption for %s', (_description, label) => {
    render(
      <ThemeProvider>
        <SessionSwitchingState onViewChanges={jest.fn()} label={label} />
      </ThemeProvider>,
    );

    expect(screen.getByText('The desktop is starting a new session.')).toBeTruthy();
  });

  it('renders a label exactly at the one-line cap', () => {
    const atCap = 'A'.repeat(45);
    render(
      <ThemeProvider>
        <SessionSwitchingState onViewChanges={jest.fn()} label={atCap} />
      </ThemeProvider>,
    );

    expect(screen.getByText(atCap)).toBeTruthy();
  });

  it('trims surrounding whitespace on an otherwise-valid label', () => {
    render(
      <ThemeProvider>
        <SessionSwitchingState onViewChanges={jest.fn()} label="  Switching agent...  " />
      </ThemeProvider>,
    );

    expect(screen.getByText('Switching agent...')).toBeTruthy();
  });

  it('always shows the View changes button, with or without a label', () => {
    const { rerender } = render(
      <ThemeProvider>
        <SessionSwitchingState onViewChanges={jest.fn()} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('session-switching-view-changes')).toBeTruthy();

    rerender(
      <ThemeProvider>
        <SessionSwitchingState onViewChanges={jest.fn()} label="Applying new settings..." />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('session-switching-view-changes')).toBeTruthy();
  });
});
