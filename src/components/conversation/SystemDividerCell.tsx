import React from 'react';
import { StyleSheet, View } from 'react-native';
import { MonoText, Text, useTheme } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';

type SystemDividerCellModel = Extract<ConversationCell, { kind: 'system-divider' }>;

export interface SystemDividerCellProps {
  cell: SystemDividerCellModel;
}

/**
 * System transcript entries rendered as quiet dividers: compaction and
 * session boundaries get a centered hairline + caption label, commands show
 * their text in mono, command output collapses to three dim mono lines.
 */
export function SystemDividerCell({ cell }: SystemDividerCellProps): React.JSX.Element {
  const theme = useTheme();

  if (cell.subtype === 'command_output') {
    return (
      <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.xs }}>
        <MonoText size="caption" color="muted" numberOfLines={3}>
          {cell.text}
        </MonoText>
      </View>
    );
  }

  const label = cell.subtype === 'compaction' ? 'context compacted' : 'new session';

  return (
    <View
      style={[
        styles.dividerRow,
        { paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm, gap: theme.spacing.sm },
      ]}
    >
      <View style={[styles.hairline, { backgroundColor: theme.colors.border }]} />
      {cell.subtype === 'command' ? (
        <MonoText size="caption" color="muted" numberOfLines={1} style={styles.dividerLabel}>
          {cell.text}
        </MonoText>
      ) : (
        <Text variant="caption" color="muted">
          {label}
        </Text>
      )}
      <View style={[styles.hairline, { backgroundColor: theme.colors.border }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  hairline: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dividerLabel: {
    flexShrink: 1,
  },
});
