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
