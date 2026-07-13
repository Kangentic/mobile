import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { Screen, SegmentedTabBar, useTheme } from '@/components';
import { findTaskById, useBoardStore } from '@/state/boardStore';
import { openSessionScreen, closeSessionScreen } from '@/connection/actions';
import { TaskHeader } from './TaskHeader';
import { ConversationTab, ConversationFooter } from './ConversationTab';
import { TerminalTab, TerminalFooter } from './TerminalTab';
import { ChangesTab } from './ChangesTab';

type TaskTabKey = 'conversation' | 'terminal' | 'changes';

const TAB_ITEMS: { key: TaskTabKey; label: string }[] = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'changes', label: 'Changes' },
];

const TAB_INDEX_BY_KEY: Record<TaskTabKey, number> = { conversation: 0, terminal: 1, changes: 2 };

/**
 * The full-screen task view: Conversation-terminal / Terminal / Changes on
 * a non-swipe pager (all three stay mounted so the xterm WebView never
 * reloads and the conversation keeps scroll position; tab switching is
 * tap-only to keep gestures unambiguous with the terminal's pan), with the
 * active tab's footer (composer or quick keys) and the tab bar inside one
 * KeyboardAvoidingView so the keyboard lifts them together.
 */
export function TaskScreen(): React.JSX.Element {
  const theme = useTheme();
  const params = useLocalSearchParams<{ taskId: string; sessionId?: string; projectId?: string }>();
  const taskId = params.taskId;

  const located = useBoardStore((state) => findTaskById(state, taskId));
  const taskTitle = located?.task.title ?? 'Task';
  const projectId = params.projectId && params.projectId.length > 0 ? params.projectId : (located?.projectId ?? null);
  const paramSessionId = params.sessionId && params.sessionId.length > 0 ? params.sessionId : null;
  const sessionId = paramSessionId ?? located?.task.session_id ?? null;

  const [activeTab, setActiveTab] = useState<TaskTabKey>('conversation');
  const pagerRef = useRef<PagerView>(null);
  // The terminal pane mounts lazily on first visit (a WebView per task
  // screen is not free), then stays alive.
  const [terminalVisited, setTerminalVisited] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    openSessionScreen(sessionId);
    return () => closeSessionScreen(sessionId);
  }, [sessionId]);

  const onTabChange = useCallback((key: string) => {
    const tabKey = key as TaskTabKey;
    setActiveTab(tabKey);
    if (tabKey === 'terminal') setTerminalVisited(true);
    pagerRef.current?.setPage(TAB_INDEX_BY_KEY[tabKey]);
  }, []);

  return (
    <Screen testID="task-screen">
      <TaskHeader taskTitle={taskTitle} sessionId={sessionId} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <PagerView ref={pagerRef} style={styles.flex} initialPage={0} scrollEnabled={false} offscreenPageLimit={2}>
          <View key="conversation" style={styles.flex} testID="task-tab-conversation">
            <ConversationTab taskId={taskId} sessionId={sessionId} projectId={projectId} />
          </View>
          <View key="terminal" style={styles.flex} testID="task-tab-terminal">
            <TerminalTab sessionId={sessionId} mounted={terminalVisited} />
          </View>
          <View key="changes" style={styles.flex} testID="task-tab-changes">
            <ChangesTab taskId={taskId} projectId={projectId} isActive={activeTab === 'changes'} />
          </View>
        </PagerView>

        {activeTab === 'conversation' ? <ConversationFooter sessionId={sessionId} /> : null}
        {activeTab === 'terminal' ? <TerminalFooter sessionId={sessionId} /> : null}

        <View style={{ paddingBottom: theme.spacing.xs, backgroundColor: theme.colors.surface }}>
          <SegmentedTabBar items={TAB_ITEMS} activeKey={activeTab} onChange={onTabChange} testID="task-tab-bar" />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
});
