import React from 'react';
import { GitMerge, GitMergeConflict, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react-native';
import type { PrChipGlyph } from './prChipPresentation';

/**
 * The PR mark for each state (see `prChipPresentation`), shared by the board
 * card's chip and the completed task's header strip so a PR reads the same in
 * both places. A switch over static imports rather than a lookup table of
 * components, so no component is chosen at render time.
 */
export function prGlyph(glyph: PrChipGlyph, color: string, size: number): React.JSX.Element {
  switch (glyph) {
    case 'merge':
      return <GitMerge size={size} color={color} />;
    case 'merge-conflict':
      return <GitMergeConflict size={size} color={color} />;
    case 'closed':
      return <GitPullRequestClosed size={size} color={color} />;
    case 'draft':
      return <GitPullRequestDraft size={size} color={color} />;
    case 'pull-request':
      return <GitPullRequest size={size} color={color} />;
  }
}
