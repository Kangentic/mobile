import React, { useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Text, useTheme } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';
import { TurnFrame } from './TurnFrame';

type ThinkingCellModel = Extract<ConversationCell, { kind: 'thinking' }>;

export interface ThinkingCellProps {
  cell: ThinkingCellModel;
}

/**
 * An assistant thinking block, collapsed by default to a single dim italic
 * caption line; tapping the 44pt row toggles the full text at caption size.
 * No inner box (matches the desktop's left-rule-only treatment) - it just
 * flows inside the turn's shared card like a bare text block.
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
    <TurnFrame turn={cell.turn}>
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
        <Text variant="caption" color="secondary">
          {cell.text}
        </Text>
      ) : null}
    </TurnFrame>
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
