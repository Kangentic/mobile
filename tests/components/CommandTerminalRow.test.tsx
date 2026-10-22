import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { CommandTerminalRow } from '@/screens/home/CommandTerminalRow';
import { useActivityStore, type SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWireFixture, seedCommandTerminalBoard } from '../helpers/commandTerminals';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));

const SESSION_ID = 'terminal-1';
const PROJECT_ID = 'project-1';
const ROW = `terminal-row-${SESSION_ID}`;

function entryFor(sessionId: string = SESSION_ID): SessionActivityEntry {
  const entry = useActivityStore.getState().bySessionId[sessionId];
  if (entry === undefined) throw new Error(`no activity entry registered for ${sessionId}`);
  return entry;
}

function snapshotTerminal(snapshot: Parameters<typeof streamSnapshotFixture>[0]): void {
  useActivityStore.getState().registerCommandTerminal(SESSION_ID, PROJECT_ID);
  useActivityStore.getState().applySnapshot(SESSION_ID, '', PROJECT_ID, streamSnapshotFixture(snapshot));
}

async function renderRow(): Promise<ReturnType<typeof render>> {
  return render(
    <ThemeProvider>
      <CommandTerminalRow entry={entryFor()} />
    </ThemeProvider>,
  );
}

describe('CommandTerminalRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    seedCommandTerminalBoard({
      terminals: [commandTerminalWireFixture({ sessionId: SESSION_ID, slot: 1, name: 'Command Terminal 1', named: false })],
    });
  });

  describe('what makes it a terminal at a glance', () => {
    it('carries the "Command Terminal" pill even when the terminal has no name of its own', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-pill`)).toHaveTextContent('Command Terminal');
    });

    it('carries the pill when the terminal is named, too, so it is never told apart by its title', async () => {
      seedCommandTerminalBoard({
        terminals: [commandTerminalWireFixture({ sessionId: SESSION_ID, slot: 1, name: 'Fix the flaky login test', named: true })],
      });
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-pill`)).toBeTruthy();
      expect(screen.getByTestId(`${ROW}-name`)).toHaveTextContent('Fix the flaky login test');
    });

    it('titles the card with the terminal\'s name from the board, and no #number', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-name`)).toHaveTextContent('Command Terminal 1');
      expect(screen.queryByText(/^#\d+/)).toBeNull();
    });

    it('falls back to a generic title when the board does not list the terminal', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      seedCommandTerminalBoard({ terminals: [] });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-name`)).toHaveTextContent('Command Terminal');
    });

    it('names the project in the band, as a task card does', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-band-project`)).toHaveTextContent('Alpha');
    });

    /**
     * The band is flush to the card's edges, as a task card's is: the card pads
     * its content by md and the CardStripBleed around the band cancels it, so
     * the band itself carries no margin of its own.
     *
     * Seen failing with the CardStripBleed swapped for a plain View: the bleed
     * lost its margins ("Expected: -12, Received: undefined" on marginTop).
     */
    it('sits in the bleed that cancels the card padding, carrying no margin of its own', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      await renderRow();

      // A bleed that lost its style flattens to undefined, so read through `?.` to fail as a value mismatch.
      const bleed = StyleSheet.flatten(screen.getByTestId(`${ROW}-strips`).props.style as StyleProp<ViewStyle>) as ViewStyle | undefined;
      expect(bleed?.marginTop).toBe(-darkTerminalTheme.spacing.md);
      expect(bleed?.marginHorizontal).toBe(-darkTerminalTheme.spacing.md);

      const band = screen.getByTestId(`${ROW}-band`);
      const bandStyle = StyleSheet.flatten(band.props.style as StyleProp<ViewStyle>) as ViewStyle;
      expect(bandStyle.marginTop).toBeUndefined();
      expect(bandStyle.marginHorizontal).toBeUndefined();
      expect(band.parent?.props.testID).toBe(`${ROW}-strips`);
    });
  });

  describe('the status mark', () => {
    it('is green while the terminal works', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: { kind: 'turn-active' } } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-mark-working`)).toBeTruthy();
      expect(screen.queryByTestId(`${ROW}-mark-needs-you`)).toBeNull();
    });

    it('is amber, the needs-you mark, once the terminal is idle', async () => {
      snapshotTerminal({ activity: { state: 'idle', reason: null } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-mark-needs-you`)).toBeTruthy();
      expect(screen.queryByTestId(`${ROW}-mark-working`)).toBeNull();
    });

    it('is amber when the terminal is asking for permission', async () => {
      snapshotTerminal({ activity: { state: 'permission', reason: null } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-mark-needs-you`)).toBeTruthy();
    });

    it('is green for a terminal the desktop has not classified yet, whatever its default state', async () => {
      useActivityStore.getState().registerCommandTerminal(SESSION_ID, PROJECT_ID);
      await renderRow();

      expect(entryFor().activityObserved).toBe(false);
      expect(screen.getByTestId(`${ROW}-mark-working`)).toBeTruthy();
    });
  });

  /**
   * The band's wait timer is gated on the desktop having CLASSIFIED the terminal
   * (`activityObserved`). An unclassified terminal sits at the store's default
   * 'idle' state, which `selectWaitingSince` reads as waiting, and its mark and
   * body already say "Starting...", so a "10m" beside them would claim the user
   * has kept a terminal waiting that never said it wanted anything.
   *
   * A register-only entry cannot pin this: it is still `feedStatus: 'pending'`,
   * which `selectWaitingSince` rejects on its own, and its clock was just
   * started, which `WaitLabel` hides for the first minute. So the entry here is
   * LIVE (a snapshot landed) and OLD (registered ten minutes ago), and the two
   * tests differ only in whether that snapshot classified the agent.
   */
  describe('the wait timer', () => {
    const REGISTERED_MS_AGO = 10 * 60_000;

    function listAgedTerminal(snapshotState: 'idle' | null): void {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - REGISTERED_MS_AGO);
      try {
        useActivityStore.getState().registerCommandTerminal(SESSION_ID, PROJECT_ID);
        useActivityStore
          .getState()
          .applySnapshot(SESSION_ID, '', PROJECT_ID, streamSnapshotFixture({ activity: { state: snapshotState, reason: null } }));
      } finally {
        nowSpy.mockRestore();
      }
    }

    it('draws no wait for a live terminal the desktop has not classified, however long it has been listed', async () => {
      listAgedTerminal(null);
      expect(entryFor().feedStatus).toBe('live');
      expect(entryFor().activityObserved).toBe(false);
      await renderRow();

      expect(screen.queryByTestId(`${ROW}-wait`)).toBeNull();
    });

    it('draws the wait once the same terminal is classified idle', async () => {
      // The control: identical age and feed status, but the snapshot classified it.
      listAgedTerminal('idle');
      expect(entryFor().activityObserved).toBe(true);
      await renderRow();

      expect(screen.getByTestId(`${ROW}-wait`)).toHaveTextContent(/10m/);
    });
  });

  describe('the body', () => {
    it('is the desktop\'s message preview when it has pushed one', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } } });
      await act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: SESSION_ID,
          taskId: '',
          payload: { type: 'message-preview', text: 'Reading the failing spec before I change it.' },
        });
      });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-snippet`)).toHaveTextContent('Reading the failing spec before I change it.');
      expect(screen.queryByText('Running Bash')).toBeNull();
    });

    it('is the desktop\'s words for the activity when it has pushed no preview', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-snippet`)).toHaveTextContent('Running Bash');
    });

    it('reads "Starting..." for a terminal the desktop has not classified yet', async () => {
      useActivityStore.getState().registerCommandTerminal(SESSION_ID, PROJECT_ID);
      await renderRow();

      expect(screen.getByTestId(`${ROW}-snippet`)).toHaveTextContent('Starting...');
    });

    /**
     * The band already shows the wait, so the activity line must not say it a
     * second time. Only an idle reason with a `since` minutes in the past can
     * tell the two apart: with no `since`, a duration-bearing line and a bare
     * one both print "Idle".
     */
    it('leaves the duration off the activity line, since the band already shows the wait', async () => {
      const idleSinceMs = Date.now() - 10 * 60_000;
      snapshotTerminal({ activity: { state: 'idle', reason: { kind: 'idle', since: idleSinceMs } } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-snippet`)).toHaveTextContent(/^Idle$/);
      expect(screen.queryByText(/ for \d+m/)).toBeNull();
      // The wait is in the band, where the duration belongs.
      expect(screen.getByTestId(`${ROW}-wait`)).toHaveTextContent(/10m/);
    });

    it('leaves the duration off an "Awaiting permission" line too', async () => {
      const waitingSinceMs = Date.now() - 5 * 60_000;
      snapshotTerminal({ activity: { state: 'permission', reason: { kind: 'permission', since: waitingSinceMs } } });
      await renderRow();

      expect(screen.getByTestId(`${ROW}-snippet`)).toHaveTextContent(/^Awaiting permission$/);
    });
  });

  describe('navigation', () => {
    it('opens the terminal by its session on a tap', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      await renderRow();

      await fireEvent.press(screen.getByTestId(ROW));

      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/command-terminal',
        params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
      });
    });

    it('opens the terminal\'s two actions on a long press, with the same params', async () => {
      snapshotTerminal({ activity: { state: 'thinking', reason: null } });
      await renderRow();

      await fireEvent(screen.getByTestId(ROW), 'longPress');

      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/command-terminal-actions',
        params: { sessionId: SESSION_ID, projectId: PROJECT_ID },
      });
    });
  });
});
