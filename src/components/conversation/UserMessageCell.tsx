import React from 'react';
import { StyleSheet, View } from 'react-native';
import { MonoText, Text, useTheme } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';

type UserMessageCellModel = Extract<ConversationCell, { kind: 'user-message' }>;

export interface UserMessageCellProps {
  cell: UserMessageCellModel;
}

/** A user turn styled as a terminal prompt line: '> ' accent prefix, body text. */
export function UserMessageCell({ cell }: UserMessageCellProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.row, { paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }]}>
      <MonoText size="body" color="accent">
        {'> '}
      </MonoText>
      <Text variant="body" color="primary" style={styles.flex}>
        {cell.entry.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  flex: {
    flex: 1,
  },
});
