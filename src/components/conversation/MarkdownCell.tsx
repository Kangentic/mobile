import React from 'react';
import { MarkdownBlock } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';
import { TurnFrame } from './TurnFrame';

type MarkdownCellModel = Extract<ConversationCell, { kind: 'markdown' }>;

export interface MarkdownCellProps {
  cell: MarkdownCellModel;
}

/** An assistant text block rendered bare (no inner box) inside its turn's shared card. */
export function MarkdownCell({ cell }: MarkdownCellProps): React.JSX.Element {
  return (
    <TurnFrame turn={cell.turn}>
      <MarkdownBlock markdown={cell.text} testID={`markdown-cell-${cell.key.replace(/:/g, '-')}`} />
    </TurnFrame>
  );
}
