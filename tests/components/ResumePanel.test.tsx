import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ResumePanel } from '@/screens/task/ResumePanel';

/**
 * The terminal lens's panel for a paused session. For a task of a PAUSED
 * WORKFLOW (protocol 0.21.0, design screen 5) it offers a single "View
 * workflow" button instead of Resume, because the desktop refuses to resume one
 * task of a paused workflow and the workflow view is the one place it resumes.
 * `useResumeOffer` decides WHICH panel (useResumeOffer.test.tsx covers that
 * gate); this file pins what the panel draws and where it goes.
 */

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockResumeTaskSession = jest.fn();
jest.mock('@/connection/actions', () => ({
  resumeTaskSession: (taskId: string, projectId: string) => mockResumeTaskSession(taskId, projectId),
}));

/** The board the task sits on, which is deliberately not the workflow's home. */
const BOARD_PROJECT_ID = 'project-1';
const HOME_PROJECT_ID = 'project-home';

async function renderPanel(pausedWorkflow?: { workflowId: string; homeProjectId: string }): Promise<void> {
  await render(
    <ThemeProvider>
      <ResumePanel taskId="task-1" projectId={BOARD_PROJECT_ID} attempt={null} pausedWorkflow={pausedWorkflow} />
    </ThemeProvider>,
  );
}

describe('ResumePanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('for a task of a paused workflow', () => {
    /**
     * Mutation seen failing: ignoring `pausedWorkflow` in the panel (the
     * workflow branch's condition made unsatisfiable, so the Resume button drew
     * in its place): "Unable to find an element with testID:
     * session-view-workflow", with `session-resume-button` in the dump.
     */
    it('offers View workflow and no Resume session', async () => {
      await renderPanel({ workflowId: 'workflow-9', homeProjectId: HOME_PROJECT_ID });

      expect(screen.getByTestId('session-view-workflow')).toBeTruthy();
      expect(screen.getByText('View workflow')).toBeTruthy();
      expect(screen.queryByTestId('session-resume-button')).toBeNull();
      expect(screen.queryByText('Resume session')).toBeNull();
    });

    /**
     * The route is pushed (not replaced), so Back returns to the session. The
     * project is the workflow's HOME, which can be another board's.
     *
     * Mutation seen failing: pushing the `projectId` prop (the task's board)
     * instead of `pausedWorkflow.homeProjectId`: the push carried "project-1"
     * where "project-home" was expected.
     */
    it('pushes the workflow view, asked of the workflow\'s home project, and starts no resume', async () => {
      await renderPanel({ workflowId: 'workflow-9', homeProjectId: HOME_PROJECT_ID });

      await fireEvent.press(screen.getByTestId('session-view-workflow'));

      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/workflow',
        params: { workflowId: 'workflow-9', projectId: HOME_PROJECT_ID },
      });
      expect(mockResumeTaskSession).not.toHaveBeenCalled();
    });
  });

  /**
   * Protocol 0.28.0: the desktop's words for why the last start never reached
   * an agent sit under the Resume button.
   *
   * Mutations seen failing: the tip's conditional removed so it never draws
   * ("Unable to find an element with testID: session-resume-start-blocked"),
   * and drawn unconditionally (the null case found the node).
   */
  describe('the start-blocked tip', () => {
    const TIP = 'Its worktree folder is gone. Resume makes it again from the branch.';

    it('draws the tip under the Resume button when given one', async () => {
      await render(
        <ThemeProvider>
          <ResumePanel taskId="task-1" projectId={BOARD_PROJECT_ID} attempt={null} startBlockedTip={TIP} />
        </ThemeProvider>,
      );

      expect(screen.getByTestId('session-resume-start-blocked')).toHaveTextContent(TIP);
      expect(screen.getByTestId('session-resume-button')).toBeTruthy();
    });

    it('draws nothing when the tip is null', async () => {
      await render(
        <ThemeProvider>
          <ResumePanel taskId="task-1" projectId={BOARD_PROJECT_ID} attempt={null} startBlockedTip={null} />
        </ThemeProvider>,
      );

      expect(screen.queryByTestId('session-resume-start-blocked')).toBeNull();
    });

    it('draws nothing when the prop is omitted', async () => {
      await renderPanel();

      expect(screen.queryByTestId('session-resume-start-blocked')).toBeNull();
    });
  });

  /**
   * Protocol 0.29.0: who paused it, as one line under the button, in the
   * desktop's words (desktop 4fe1dfbdb, `TaskDetailBody`'s `pauseNote`). The
   * panel draws it only at rest, as the desktop does: not while a resume runs,
   * not after one fails (that line speaks instead) and not beside a blocked
   * start's tip.
   *
   * Mutations seen failing: `pauseNoteShown` forced false (the two drawn
   * cases found no node), and the three rest conditions dropped from it (each
   * hidden case found the node; each sets up only its own condition, so it
   * fails for that one alone).
   */
  describe('the pause line', () => {
    const IDLE_NOTE = 'Paused while idle.';
    const HELD_NOTE = 'Stays paused until resumed.';

    async function renderWithNote(props: Partial<React.ComponentProps<typeof ResumePanel>>): Promise<void> {
      await render(
        <ThemeProvider>
          <ResumePanel taskId="task-1" projectId={BOARD_PROJECT_ID} attempt={null} {...props} />
        </ThemeProvider>,
      );
    }

    it.each([
      ['an idle pause', IDLE_NOTE],
      ['a held pause', HELD_NOTE],
    ])('draws the line for %s under the Resume button', async (_label, note) => {
      await renderWithNote({ pauseNote: note });

      expect(screen.getByTestId('session-resume-pause-note')).toHaveTextContent(note);
      expect(screen.getByTestId('session-resume-button')).toBeTruthy();
    });

    it('draws nothing for no note (the desktop\'s own pause, or an older desktop)', async () => {
      await renderWithNote({ pauseNote: null });

      expect(screen.queryByTestId('session-resume-pause-note')).toBeNull();
    });

    it('draws nothing while a resume runs', async () => {
      await renderWithNote({ pauseNote: IDLE_NOTE, attempt: { phase: 'resuming', startedAt: 1, origin: 'open' } });

      expect(screen.queryByTestId('session-resume-pause-note')).toBeNull();
      expect(screen.getByText('Resuming agent...')).toBeTruthy();
    });

    it('gives way to the failure line after a resume fails', async () => {
      await renderWithNote({ pauseNote: HELD_NOTE, attempt: { phase: 'failed', message: 'The desktop said no.' } });

      expect(screen.queryByTestId('session-resume-pause-note')).toBeNull();
      expect(screen.getByTestId('session-resume-error')).toHaveTextContent('The desktop said no.');
    });

    it('gives way to a blocked start\'s tip', async () => {
      await renderWithNote({ pauseNote: HELD_NOTE, startBlockedTip: 'Its worktree folder is gone. Resume makes it again from the branch.' });

      expect(screen.queryByTestId('session-resume-pause-note')).toBeNull();
      expect(screen.getByTestId('session-resume-start-blocked')).toBeTruthy();
    });

    it('draws nothing for a task of a paused workflow, which offers View workflow alone', async () => {
      await renderWithNote({ pauseNote: HELD_NOTE, pausedWorkflow: { workflowId: 'workflow-9', homeProjectId: HOME_PROJECT_ID } });

      expect(screen.queryByTestId('session-resume-pause-note')).toBeNull();
      expect(screen.getByTestId('session-view-workflow')).toBeTruthy();
    });
  });

  describe('for any other paused task', () => {
    it('keeps the Resume session button, with no View workflow beside it', async () => {
      await renderPanel();

      expect(screen.getByTestId('session-resume-button')).toBeTruthy();
      expect(screen.getByText('Resume session')).toBeTruthy();
      expect(screen.queryByTestId('session-view-workflow')).toBeNull();
    });

    it('resumes the task on its own board when the button is pressed', async () => {
      await renderPanel();

      await fireEvent.press(screen.getByTestId('session-resume-button'));

      expect(mockResumeTaskSession).toHaveBeenCalledWith('task-1', BOARD_PROJECT_ID);
      expect(mockPush).not.toHaveBeenCalled();
    });
  });
});
