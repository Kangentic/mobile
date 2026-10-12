import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TerminalTab, type TerminalTabProps } from '@/screens/task/TerminalTab';

/**
 * TerminalTab is the seam between a screen and the xterm pane: SessionScreen
 * and the Command Terminal screen both render it, and each of their own suites
 * stubs it out. So nothing else checks that what the tab is told reaches the
 * pane, and one prop matters more than the rest: `inputEnabled`. The Command
 * Terminal screen holds it false until the desktop has classified the terminal's
 * agent (before then the PTY can be a bare shell, and keeping it untyped is the
 * phone's half of the "no shell reach" promise). A tab that dropped the prop
 * would hand the pane its own default, which types.
 *
 * The pane is a recorder here: the real one mounts the WebView, and its own
 * input handling is TerminalPane.test.tsx's.
 *
 * Mutations seen failing: dropping `inputEnabled={inputEnabled}` from the pane
 * (the two input tests, "Expected: false, Received: undefined"), and hard-coding
 * the placeholder sentence in place of `{emptyMessage}` (the custom-line and
 * empty-line tests).
 */
interface RecordedPaneProps {
  sessionId: string;
  isActive: boolean;
  cleanFeedEnabled?: boolean;
  fitLayoutIsReference?: boolean;
  inputEnabled?: boolean;
}

const mockPaneProps: { current: RecordedPaneProps | null } = { current: null };
jest.mock('@/components/terminal/TerminalPane', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    TerminalPane: (props: RecordedPaneProps) => {
      mockPaneProps.current = props;
      return ReactModule.createElement(View, { testID: 'stub-terminal-pane' });
    },
  };
});

async function renderTab(overrides: Partial<TerminalTabProps> = {}): Promise<void> {
  const props: TerminalTabProps = { sessionId: 'sess-1', active: true, ...overrides };
  await render(
    <ThemeProvider>
      <TerminalTab {...props} />
    </ThemeProvider>,
  );
}

describe('TerminalTab', () => {
  beforeEach(() => {
    mockPaneProps.current = null;
  });

  describe('with a session', () => {
    it('hands the pane the session, and the visibility as isActive', async () => {
      await renderTab({ sessionId: 'sess-9', active: false });

      expect(screen.getByTestId('stub-terminal-pane')).toBeTruthy();
      expect(mockPaneProps.current?.sessionId).toBe('sess-9');
      expect(mockPaneProps.current?.isActive).toBe(false);
    });

    it('lets the pane type by default, so a task session is unchanged', async () => {
      await renderTab();

      expect(mockPaneProps.current?.inputEnabled).toBe(true);
    });

    it('hands the pane a held input when told to hold it', async () => {
      await renderTab({ inputEnabled: false });

      expect(mockPaneProps.current?.inputEnabled).toBe(false);
    });

    it('hands the pane its other props, and the defaults a task session relies on', async () => {
      await renderTab();
      expect(mockPaneProps.current?.cleanFeedEnabled).toBe(false);
      expect(mockPaneProps.current?.fitLayoutIsReference).toBe(true);

      await screen.unmount();
      await renderTab({ cleanFeedEnabled: true, fitLayoutIsReference: false });
      expect(mockPaneProps.current?.cleanFeedEnabled).toBe(true);
      expect(mockPaneProps.current?.fitLayoutIsReference).toBe(false);
    });
  });

  describe('without a session', () => {
    it('draws the task placeholder and no pane by default', async () => {
      await renderTab({ sessionId: null });

      expect(screen.getByText('No active session for this task')).toBeTruthy();
      expect(screen.queryByTestId('stub-terminal-pane')).toBeNull();
      expect(mockPaneProps.current).toBeNull();
    });

    it('draws the caller\'s own line instead of the task one', async () => {
      await renderTab({ sessionId: null, emptyMessage: 'Nothing to show' });

      expect(screen.getByText('Nothing to show')).toBeTruthy();
      expect(screen.queryByText('No active session for this task')).toBeNull();
    });

    // The Command Terminal screen passes an empty line: its starting face
    // already says what is happening, and a task sentence under it would be wrong.
    it('draws no task sentence when the caller passes an empty line', async () => {
      await renderTab({ sessionId: null, emptyMessage: '' });

      expect(screen.queryByText('No active session for this task')).toBeNull();
      expect(screen.queryByTestId('stub-terminal-pane')).toBeNull();
    });
  });
});
