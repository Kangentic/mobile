import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { QuickKeyBar } from '@/components/terminal/QuickKeyBar';

jest.mock('@/connection/actions', () => ({
  writeTerminal: jest.fn().mockResolvedValue(undefined),
}));

const EXPECTED_SEQUENCES: { testID: string; sequence: string }[] = [
  { testID: 'quick-key-esc', sequence: '\x1b' },
  { testID: 'quick-key-tab', sequence: '\t' },
  { testID: 'quick-key-up', sequence: '\x1b[A' },
  { testID: 'quick-key-down', sequence: '\x1b[B' },
  { testID: 'quick-key-left', sequence: '\x1b[D' },
  { testID: 'quick-key-right', sequence: '\x1b[C' },
  { testID: 'quick-key-enter', sequence: '\r' },
  { testID: 'quick-key-ctrl-c', sequence: '\x03' },
  { testID: 'quick-key-slash', sequence: '/' },
];

describe('QuickKeyBar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each(EXPECTED_SEQUENCES)('writes the exact byte sequence for $testID', ({ testID, sequence }) => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');

    render(
      <ThemeProvider>
        <QuickKeyBar sessionId="sess-1" />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId(testID));
    expect(writeTerminal).toHaveBeenCalledTimes(1);
    expect(writeTerminal).toHaveBeenCalledWith('sess-1', sequence);
  });
});
