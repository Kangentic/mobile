import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack, Text } from '@/components';

export interface ConversationTabProps {
  taskId: string;
  sessionId: string | null;
  projectId: string | null;
}

/** Placeholder - the conversation-terminal renderer lands with the conversation surface work. */
export function ConversationTab({ sessionId }: ConversationTabProps): React.JSX.Element {
  return (
    <Stack gap="sm" style={styles.placeholder}>
      <Text variant="body" color="secondary">
        {sessionId ? 'Conversation loading...' : 'No active session for this task'}
      </Text>
    </Stack>
  );
}

export interface ConversationFooterProps {
  sessionId: string | null;
}

/** Placeholder - the composer lands with the conversation surface work. */
export function ConversationFooter(_props: ConversationFooterProps): React.JSX.Element | null {
  return null;
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
