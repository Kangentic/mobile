import React from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Screen } from '@/components';
import { findTaskById, useBoardStore } from '@/state/boardStore';
import { TaskHeader } from './TaskHeader';
import { ChangesTab } from './ChangesTab';

/**
 * The task's CHANGES destination, pushed over the Session screen (which
 * stays mounted underneath, xterm WebView included). The diff watch is
 * screen-scoped: mounted = watching; popping the screen tears it down.
 */
export function ChangesScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ taskId: string; projectId?: string }>();
  const taskId = params.taskId;
  const locatedTaskTitle = useBoardStore((state) => findTaskById(state, taskId)?.task.title ?? null);
  const locatedProjectId = useBoardStore((state) => findTaskById(state, taskId)?.projectId ?? null);
  const locatedSessionId = useBoardStore((state) => findTaskById(state, taskId)?.task.session_id ?? null);
  const projectId = params.projectId && params.projectId.length > 0 ? params.projectId : locatedProjectId;

  return (
    <Screen testID="changes-screen">
      <TaskHeader taskTitle={locatedTaskTitle ?? 'Changes'} sessionId={locatedSessionId} />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ChangesTab taskId={taskId} projectId={projectId} isActive={true} />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
});
