import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Row } from './Row';
import { Text, type TextColorRole } from './Text';

export interface BadgeProps {
  label: string;
  color?: TextColorRole;
  /** Pills read against the card surface via the overlay background plus a hairline border (on by default; pass false for a flat pill on non-card surfaces). */
  outlined?: boolean;
  /** `rect` (default) is the tag/label corner radius; `pill` is fully stadium-rounded, for a short numeric count or a compact text tag. */
  shape?: 'rect' | 'pill';
  /** A small leading glyph (e.g. a PR-state icon) inside the same pill, rather than a bare icon+text sitting unstyled next to it. */
  icon?: React.ReactNode;
  /**
   * A visibly smaller pill for a bare short count sitting inline next to
   * other text (e.g. a section header's row count) - tightens the padding
   * around the digit so the pill reads shorter than the text beside it,
   * without going all the way to unstyled text (which reads as too weak a
   * signal - see .claude/rules/ui-conventions.md on visible tap/read targets).
   */
  compact?: boolean;
  testID?: string;
}

export function Badge({
  label,
  color = 'secondary',
  outlined = true,
  shape = 'rect',
  icon,
  compact = false,
  testID,
}: BadgeProps): React.JSX.Element {
  const theme = useTheme();
  const isPill = shape === 'pill';
  const content = (
    <Text variant="caption" color={color}>
      {label}
    </Text>
  );
  return (
    <View
      testID={testID}
      style={[
        styles.base,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          borderRadius: isPill ? theme.radii.full : theme.radii.sm,
          // Same horizontal padding as the rect shape: a pill's rounded ends
          // need room to breathe around the text, not less than a rect gets.
          paddingHorizontal: compact ? theme.spacing.xs : theme.spacing.sm,
          paddingVertical: compact ? theme.spacing.xs / 4 : theme.spacing.xs / 2,
          minWidth: isPill ? (compact ? theme.spacing.md : theme.spacing.lg) : undefined,
          alignItems: isPill ? 'center' : undefined,
          borderWidth: outlined ? StyleSheet.hairlineWidth : 0,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {icon ? (
        <Row gap="xs" style={styles.iconRow}>
          {icon}
          {content}
        </Row>
      ) : (
        content
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
  },
  iconRow: {
    alignItems: 'center',
  },
});
