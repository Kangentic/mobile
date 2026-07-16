import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack, Text, useTheme } from '@/components';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { QuickKeyBar } from '@/components/terminal/QuickKeyBar';
import { TerminalInputRow } from '@/components/terminal/TerminalInputRow';

export interface TerminalTabProps {
  sessionId: string | null;
  /** True once the tab has been visited - the xterm WebView mounts lazily. */
  mounted: boolean;
}

/** The raw interactive terminal mirror tab: the xterm WebView, mounted on first visit. */
export function TerminalTab({ sessionId, mounted }: TerminalTabProps): React.JSX.Element {
  if (sessionId === null) {
    return (
      <Stack gap="sm" style={styles.placeholder}>
        <Text variant="body" color="secondary">
          No active session for this task
        </Text>
      </Stack>
    );
  }
  if (!mounted) {
    return (
      <Stack gap="sm" style={styles.placeholder}>
        <Text variant="body" color="secondary">
          Open this tab to attach the terminal
        </Text>
      </Stack>
    );
  }
  return <TerminalPane sessionId={sessionId} />;
}

export interface TerminalFooterProps {
  sessionId: string | null;
}

/** Quick keys above the line composer; the TaskScreen keyboard-avoids both together. */
export function TerminalFooter({ sessionId }: TerminalFooterProps): React.JSX.Element | null {
  const theme = useTheme();
  if (sessionId === null) return null;
  return (
    <Stack
      gap="xs"
      style={{
        backgroundColor: theme.colors.surface,
        paddingHorizontal: theme.spacing.sm,
        paddingVertical: theme.spacing.xs,
      }}
    >
      <QuickKeyBar sessionId={sessionId} />
      <TerminalInputRow sessionId={sessionId} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
