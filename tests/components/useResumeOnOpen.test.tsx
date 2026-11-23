import React from 'react';
import { act, render } from '@testing-library/react-native';
import { resumeTaskOnOpen } from '@/connection/actions';
import { noteTaskOpened, resetTaskOpenIntentForTests } from '@/navigation/taskOpenIntent';
import { useResumeOnOpen } from '@/screens/task/useResumeOnOpen';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';

jest.mock('@/connection/actions', () => ({
  resumeTaskOnOpen: jest.fn(),
}));

interface ProbeProps {
  readonly taskId: string | null;
  readonly renders: boolean[];
}

/** Pushes every render's return value, so the FIRST render is observable. */
function Probe({ taskId, renders }: ProbeProps): null {
  const openPending = useResumeOnOpen({ taskId, projectId: 'project-a', offered: true });
  renders.push(openPending);
  return null;
}

describe('useResumeOnOpen openPending', () => {
  beforeEach(() => {
    resetTaskOpenIntentForTests();
    (resumeTaskOnOpen as jest.Mock).mockClear();
    // The board is never current, so the decide effect cannot fire.
    useChannelStore.setState({ establishedAt: null });
    useBoardStore.setState({ boardsByProjectId: {} });
  });

  afterEach(() => {
    resetTaskOpenIntentForTests();
  });

  it('is true on the very first render when an open is noted for the task', async () => {
    noteTaskOpened('task-a');
    const renders: boolean[] = [];
    await render(<Probe taskId="task-a" renders={renders} />);
    expect(renders[0]).toBe(true);
    expect(renders[renders.length - 1]).toBe(true);
    expect(resumeTaskOnOpen).not.toHaveBeenCalled();
  });

  it('is false on the first render when no open is noted', async () => {
    const renders: boolean[] = [];
    await render(<Probe taskId="task-a" renders={renders} />);
    expect(renders[0]).toBe(false);
    expect(resumeTaskOnOpen).not.toHaveBeenCalled();
  });

  it('does not carry a pending open to a different task on a task change', async () => {
    // Lines "if (!claimed.current) setOpenPending(false)" and the effect cleanup's
    // setOpenPending(false) back each other up on this path, so this test only
    // goes red when BOTH are removed.
    noteTaskOpened('task-a');
    const renders: boolean[] = [];
    const view = await render(<Probe taskId="task-a" renders={renders} />);
    expect(renders[renders.length - 1]).toBe(true);

    await act(() => {
      view.rerender(<Probe taskId="task-b" renders={renders} />);
    });
    expect(renders[renders.length - 1]).toBe(false);
    expect(resumeTaskOnOpen).not.toHaveBeenCalled();
  });
});
