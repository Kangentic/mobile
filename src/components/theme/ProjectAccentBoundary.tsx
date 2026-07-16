import React, { useMemo } from 'react';
import { selectProjectAccentColor, useBoardStore } from '@/state/boardStore';
import { ThemeProvider, useTheme } from './ThemeProvider';
import { applyProjectAccent } from './projectAccent';

export interface ProjectAccentBoundaryProps {
  /** Tolerates missing route params: null/undefined passes the base theme through. */
  projectId: string | null | undefined;
  children: React.ReactNode;
}

/**
 * Scopes the per-project accent overlay to a subtree: reads the project's
 * desktop-provided accent color from the board store (a field that is
 * optional on the wire; see selectProjectAccentColor) and nests a
 * ThemeProvider with only the accent family replaced. When no color is
 * available, or it fails the projectAccent guardrails, children render on the
 * unmodified base theme, so this is land-safe whether or not the wire field
 * ships.
 */
export function ProjectAccentBoundary({ projectId, children }: ProjectAccentBoundaryProps): React.JSX.Element {
  const baseTheme = useTheme();
  const projectAccentColor = useBoardStore((state) =>
    typeof projectId === 'string' && projectId.length > 0 ? selectProjectAccentColor(state, projectId) : null,
  );
  const theme = useMemo(
    () => (projectAccentColor === null ? baseTheme : applyProjectAccent(baseTheme, projectAccentColor)),
    [baseTheme, projectAccentColor],
  );
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
