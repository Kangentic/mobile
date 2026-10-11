import { StyleSheet, type ViewStyle } from 'react-native';
import type { Theme } from './theme/tokens';

/**
 * The surface every tappable row in a bottom sheet sits on: the action rows,
 * the project, column and section pickers. A raised fill with a hairline
 * outline, so a sheet reads as a set of buttons rather than a menu of text
 * (ui-conventions.md, visible tap targets). A selected row takes the accent
 * wash and the muted accent outline, the same pair the Board's active column
 * chip wears.
 *
 * Rows stack `theme.spacing.xs` apart; the caller owns that gap.
 */
export function sheetRowSurface(theme: Theme, selected = false): ViewStyle {
  return {
    backgroundColor: selected ? theme.colors.accentSubtle : theme.colors.surfaceRaised,
    borderColor: selected ? theme.colors.accentMuted : theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: theme.radii.md,
  };
}
