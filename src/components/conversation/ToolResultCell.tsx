import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { MonoText, useTheme } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';

type ToolResultOrphanCellModel = Extract<ConversationCell, { kind: 'tool-result-orphan' }>;

const RESULT_EXPANDED_MAX_HEIGHT = 400;

export interface ToolResultBlockProps {
  content: string;
  isError: boolean;
  testID: string;
}

/**
 * A tool result: a two-line mono preview that expands on tap to the full
 * content (height-capped with its own scroll). The left border alone marks
 * it as nested under the tool call above - no leading glyph needed on top
 * of that (would just duplicate the same "this is nested" cue).  Error
 * results carry a danger-tinted left border and danger text.
 */
export function ToolResultBlock({ content, isError, testID }: ToolResultBlockProps): React.JSX.Element {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  // Reset per-item UI state when FlashList recycles this component for a different result.
  const [trackedTestId, setTrackedTestId] = useState(testID);
  if (trackedTestId !== testID) {
    setTrackedTestId(testID);
    setExpanded(false);
  }

  const displayText = content.trimEnd();
  const textColor = isError ? ('danger' as const) : ('secondary' as const);

  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={() => setExpanded((previousExpanded) => !previousExpanded)}
      style={[
        styles.resultBlock,
        {
          borderLeftColor: isError ? theme.colors.danger : theme.colors.border,
          marginTop: theme.spacing.xs,
          paddingLeft: theme.spacing.sm,
          paddingVertical: theme.spacing.xs,
          minHeight: theme.minTouchSize,
        },
      ]}
    >
      {expanded ? (
        <ScrollView style={styles.expandedScroll} nestedScrollEnabled>
          <MonoText size="caption" color={textColor}>
            {displayText}
          </MonoText>
        </ScrollView>
      ) : (
        <MonoText size="caption" color={textColor} numberOfLines={2}>
          {displayText}
        </MonoText>
      )}
    </Pressable>
  );
}

export interface ToolResultCellProps {
  cell: ToolResultOrphanCellModel;
}

/** The orphan-result fallback: a tool_result whose tool_use never appeared earlier in the transcript. */
export function ToolResultCell({ cell }: ToolResultCellProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.xs }}>
      <ToolResultBlock content={cell.content} isError={cell.isError} testID={`orphan-result-${cell.key}`} />
    </View>
  );
}

const styles = StyleSheet.create({
  resultBlock: {
    borderLeftWidth: 2,
    justifyContent: 'center',
  },
  expandedScroll: {
    maxHeight: RESULT_EXPANDED_MAX_HEIGHT,
  },
});
