import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';

type ThinkingCellModel = Extract<ConversationCell, { kind: 'thinking' }>;

export interface ThinkingCellProps {
  cell: ThinkingCellModel;
}

/**
 * An assistant thinking block, collapsed by default to a single dim italic
 * caption line; tapping the 44pt row toggles the full text at caption size.
 */
export function ThinkingCell({ cell }: ThinkingCellProps): React.JSX.Element {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  // Reset per-item UI state when FlashList recycles this component for a different block.
  const [trackedCellKey, setTrackedCellKey] = useState(cell.key);
  if (trackedCellKey !== cell.key) {
    setTrackedCellKey(cell.key);
    setExpanded(false);
  }

  return (
    <View style={{ paddingHorizontal: theme.spacing.md }}>
      <Pressable
        accessibilityRole="button"
        testID={`thinking-toggle-${cell.key.replace(/:/g, '-')}`}
        onPress={() => setExpanded((previousExpanded) => !previousExpanded)}
        style={[styles.toggleRow, { minHeight: theme.minTouchSize }]}
      >
        <Text variant="caption" color="muted" style={styles.italic} numberOfLines={1}>
          {`* Thinking - ${cell.text.length} chars`}
        </Text>
      </Pressable>
      {expanded ? (
        <Text variant="caption" color="secondary" style={{ paddingBottom: theme.spacing.sm }}>
          {cell.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    justifyContent: 'center',
  },
  italic: {
    fontStyle: 'italic',
  },
});
