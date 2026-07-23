import React from 'react';
import { Text } from '@/components';
import type { ConversationCell } from '@/conversation/transcriptCells';
import { TurnFrame } from './TurnFrame';

type UserMessageCellModel = Extract<ConversationCell, { kind: 'user-message' }>;

export interface UserMessageCellProps {
  cell: UserMessageCellModel;
}

/** A user turn's body text - the turn header's "You" badge already names the speaker. */
export function UserMessageCell({ cell }: UserMessageCellProps): React.JSX.Element {
  return (
    <TurnFrame turn={cell.turn}>
      <Text variant="body" color="primary">
        {cell.entry.text}
      </Text>
    </TurnFrame>
  );
}
