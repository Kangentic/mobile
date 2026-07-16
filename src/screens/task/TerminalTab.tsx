import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack, Text } from '@/components';
import { TerminalPane } from '@/components/terminal/TerminalPane';

export interface TerminalTabProps {
  sessionId: string | null;
  /** True while the terminal is the visible session lens; pauses WebView repaint when false. */
  active: boolean;
  /** Enables the WebView's clean feed for the chat reading view (sessions without a structured transcript). */
  cleanFeedEnabled?: boolean;
}

/**
 * The raw interactive terminal lens: a FAITHFUL MIRROR of the desktop
 * terminal in an xterm WebView, mounted with the Session screen (terminal
 * is the default lens). It renders the desktop's grid 1:1 and never resizes
 * the shared session; pinch-zoom + pan read the detail.
 */
export function TerminalTab({ sessionId, active, cleanFeedEnabled = false }: TerminalTabProps): React.JSX.Element {
  if (sessionId === null) {
    return (
      <Stack gap="sm" style={styles.placeholder}>
        <Text variant="body" color="secondary">
          No active session for this task
        </Text>
      </Stack>
    );
  }
  return <TerminalPane sessionId={sessionId} isActive={active} cleanFeedEnabled={cleanFeedEnabled} />;
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
