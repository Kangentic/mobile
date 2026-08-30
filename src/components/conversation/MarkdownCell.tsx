import React from 'react';
import { MarkdownBlock, Text } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';
import { TurnFrame } from './TurnFrame';

type MarkdownCellModel = Extract<ConversationCell, { kind: 'markdown' }>;

export interface MarkdownCellProps {
  cell: MarkdownCellModel;
}

/** An assistant text block rendered bare (no inner box) inside its turn's shared card. */
export function MarkdownCell({ cell }: MarkdownCellProps): React.JSX.Element {
  const testID = `markdown-cell-${cell.key.replace(/:/g, '-')}`;
  // Retention bisect: swaps the native markdown view for a plain Text.
  if (getRetentionProbeVariant() === 'plain-markdown') {
    return (
      <TurnFrame turn={cell.turn}>
        <Text variant="body" testID={testID}>
          {cell.text}
        </Text>
      </TurnFrame>
    );
  }
  return (
    <TurnFrame turn={cell.turn}>
      <MarkdownBlock markdown={cell.text} testID={testID} />
    </TurnFrame>
  );
}
