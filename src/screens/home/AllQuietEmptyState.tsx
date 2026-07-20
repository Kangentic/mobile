import React from 'react';
import { EmptyState } from '@/components';

/**
 * Paired, connected, and nothing running: the calm state, kept as the single
 * all-quiet surface so the Overseer has one home on the Home screen.
 */
export function AllQuietEmptyState(): React.JSX.Element {
  return (
    <EmptyState
      testID="all-quiet-empty-state"
      title="All quiet"
      caption="Agents you start on the desktop show up here."
      overseerSize={90}
      overseerAnimate="blink-loop"
    />
  );
}
