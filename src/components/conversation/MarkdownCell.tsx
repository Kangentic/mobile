import React from 'react';
import { View } from 'react-native';
import { MarkdownBlock, useTheme } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';

type MarkdownCellModel = Extract<ConversationCell, { kind: 'markdown' }>;

export interface MarkdownCellProps {
  cell: MarkdownCellModel;
}

/** An assistant text block rendered as markdown. */
export function MarkdownCell({ cell }: MarkdownCellProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: theme.spacing.md }}>
      <MarkdownBlock markdown={cell.text} testID={`markdown-cell-${cell.key.replace(/:/g, '-')}`} />
    </View>
  );
}
