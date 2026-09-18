import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { ThemeProvider, darkTerminalTheme } from '@/components';
import { SESSION_WAITING_BODY, SESSION_WAITING_TITLE, SessionWaitingState } from '@/screens/task/SessionWaitingState';

const { opacityMin, opacityMax } = darkTerminalTheme.motion.swapVeilPulse;

/**
 * The card's own contract. WHEN it shows (past the quiet window with the
 * dead session still bound, terminal mode only, never on a screen on its way
 * out) is SessionScreen's, pinned in SessionScreen.session-swap.test.tsx.
 * `session-waiting-state` and `session-waiting-read-transcript` are Maestro
 * anchors (.maestro/paired/session-ended-state.yaml); their testIDs must not
 * change.
 */
describe('SessionWaitingState', () => {
  function renderCard(onMoveTask: (() => void) | null = jest.fn(), onReadTranscript = jest.fn()): void {
    render(
      <ThemeProvider>
        <SessionWaitingState onReadTranscript={onReadTranscript} onMoveTask={onMoveTask} />
      </ThemeProvider>,
    );
  }

  it('renders the two lines and fires both actions', () => {
    const onReadTranscript = jest.fn();
    const onMoveTask = jest.fn();
    renderCard(onMoveTask, onReadTranscript);

    expect(screen.getByText(SESSION_WAITING_TITLE)).toBeTruthy();
    expect(screen.getByText(SESSION_WAITING_BODY)).toBeTruthy();

    fireEvent.press(screen.getByTestId('session-waiting-read-transcript'));
    expect(onReadTranscript).toHaveBeenCalledTimes(1);
    fireEvent.press(screen.getByTestId('session-waiting-move-task'));
    expect(onMoveTask).toHaveBeenCalledTimes(1);
  });

  it('omits Move task when no board holds the task', () => {
    renderCard(null);
    expect(screen.queryByTestId('session-waiting-move-task')).toBeNull();
    expect(screen.getByTestId('session-waiting-read-transcript')).toBeTruthy();
  });

  /**
   * The copy decision, pinned as a whole: a card, not a verdict. No "ended",
   * no time, no column, and no hint about what a move would do (that depends
   * on how the board is set up). Anything added "for clarity" fails here.
   */
  it('says nothing the phone cannot know: the title, the one line, and the two labels only', () => {
    renderCard();

    const renderedText = screen
      .UNSAFE_queryAllByType(Text)
      .map((node) => node.props.children)
      .filter((children): children is string => typeof children === 'string')
      .sort();
    expect(renderedText).toEqual([SESSION_WAITING_BODY, 'Move task', 'Read transcript', SESSION_WAITING_TITLE].sort());
    expect(SESSION_WAITING_TITLE).toBe('Waiting for the desktop');
    expect(SESSION_WAITING_BODY).toBe('This screen updates as soon as it reports a session for this task.');
  });

  /**
   * A scrim, not a curtain: the last frame stays under the card at the
   * veil's resting opacity, so the deadline changes nothing under it. The
   * old ended state painted an opaque background here, which is the black
   * pane the redesign removed.
   */
  it('keeps the last frame under the veil resting scrim rather than an opaque pane', () => {
    renderCard();

    const scrim = screen.getByTestId('session-waiting-scrim');
    const scrimStyle = StyleSheet.flatten(scrim.props.style);
    expect(scrimStyle.opacity).toBe((opacityMin + opacityMax) / 2);
    expect(scrimStyle.backgroundColor).toBe(darkTerminalTheme.colors.background);
    expect(scrim.props.pointerEvents).toBe('none');
    const overlayStyle = StyleSheet.flatten(screen.getByTestId('session-waiting-state').props.style);
    expect(overlayStyle.backgroundColor).toBeUndefined();
  });

  /** One call to action raised, the alternative outlined beneath it: never two ghost labels. */
  it('raises Read transcript as the primary and outlines Move task', () => {
    renderCard();

    const primaryStyle = StyleSheet.flatten(screen.getByTestId('session-waiting-read-transcript').props.style);
    expect(primaryStyle.backgroundColor).toBe(darkTerminalTheme.colors.accent);
    const secondaryStyle = StyleSheet.flatten(screen.getByTestId('session-waiting-move-task').props.style);
    expect(secondaryStyle.backgroundColor).toBe('transparent');
    expect(secondaryStyle.borderWidth).toBeGreaterThan(0);
    expect(secondaryStyle.borderColor).toBe(darkTerminalTheme.colors.border);
  });

  /** Above the panes' zIndex: 1 (the stacking pin the old overlays carried), and modal to VoiceOver. */
  it('stacks above the session panes and is modal to a screen reader', () => {
    renderCard();

    const overlay = screen.getByTestId('session-waiting-state');
    const overlayStyle = StyleSheet.flatten(overlay.props.style);
    expect(typeof overlayStyle.zIndex).toBe('number');
    expect(overlayStyle.zIndex).toBeGreaterThanOrEqual(2);
    expect(overlay.props.accessibilityViewIsModal).toBe(true);
  });
});
