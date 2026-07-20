import React from 'react';
import { EmptyState } from '@/components';

/**
 * Paired but the secure channel is not established yet (cold start, relay
 * or desktop coming back): the Overseer holds the center instead of a
 * black void while the link comes up.
 */
export function ConnectingEmptyState(): React.JSX.Element {
  return (
    <EmptyState
      testID="connecting-empty-state"
      title="Connecting to your desktop…"
      caption="Your agents appear here once it connects."
      overseerSize={90}
      overseerAnimate="blink-loop"
    />
  );
}
