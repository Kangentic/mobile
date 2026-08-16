import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { Screen } from '@/components';
import { findTaskById, useBoardStore } from '@/state/boardStore';
import { TaskHeader } from './TaskHeader';
import { ChangesTab } from './ChangesTab';

/**
 * The task's CHANGES destination, pushed over the Session screen (which
 * stays mounted underneath, xterm WebView included). The diff watch is
 * screen-scoped: mounted = watching; popping the screen tears it down.
 *
 * No KeyboardAvoidingView: this screen is a diff list with no text input, so
 * the keyboard never comes up over it. The one it used to carry was worse
 * than useless - it applied `padding` on iOS only, which is the RN default
 * advice but WRONG for this app: edge-to-edge Android never resizes the
 * window for the soft keyboard either, which is why SessionScreen applies
 * padding on BOTH platforms (see 71f5fdd, where the keyboard covered the
 * composer's send button). Two neighbouring screens disagreeing about that is
 * how the wrong one gets copied next.
 */
export function ChangesScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ taskId: string; projectId?: string }>();
  const taskId = params.taskId;
  const locatedTaskTitle = useBoardStore((state) => findTaskById(state, taskId)?.task.title ?? null);
  const locatedProjectId = useBoardStore((state) => findTaskById(state, taskId)?.projectId ?? null);
  const locatedSessionId = useBoardStore((state) => findTaskById(state, taskId)?.task.session_id ?? null);
  const locatedDisplayId = useBoardStore((state) => {
    const located = findTaskById(state, taskId);
    if (!located) return null;
    return (state.boardsByProjectId[located.projectId]?.showTicketNumbers ?? true) ? located.task.display_id : null;
  });
  const projectId = params.projectId && params.projectId.length > 0 ? params.projectId : locatedProjectId;

  return (
    <Screen testID="changes-screen">
      <TaskHeader taskTitle={locatedTaskTitle ?? 'Changes'} sessionId={locatedSessionId} displayId={locatedDisplayId} taskId={taskId} />
      <ChangesTab taskId={taskId} projectId={projectId} isActive={true} />
    </Screen>
  );
}
