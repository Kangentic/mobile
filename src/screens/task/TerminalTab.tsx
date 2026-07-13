import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack, Text } from '@/components';

export interface TerminalTabProps {
  sessionId: string | null;
  /** True once the tab has been visited - the xterm WebView mounts lazily. */
  mounted: boolean;
}

/** Placeholder - the xterm.js mirror lands with the terminal surface work. */
export function TerminalTab({ sessionId, mounted }: TerminalTabProps): React.JSX.Element {
  return (
    <Stack gap="sm" style={styles.placeholder}>
      <Text variant="body" color="secondary">
        {sessionId && mounted ? 'Terminal loading...' : 'No active session for this task'}
      </Text>
    </Stack>
  );
}

export interface TerminalFooterProps {
  sessionId: string | null;
}

/** Placeholder - the quick-key bar + terminal input row land with the terminal surface work. */
export function TerminalFooter(_props: TerminalFooterProps): React.JSX.Element | null {
  return null;
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
