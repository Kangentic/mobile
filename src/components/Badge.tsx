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
  /**
   * Cross-axis alignment of the pill itself, which does two different jobs
   * depending on the container.
   *
   * `start` (the default) shrink-wraps it. In a `Stack` the cross axis is
   * horizontal, so the inherited `stretch` would blow a short header pill out
   * to the full card width (see AskUserQuestionCard).
   *
   * `center` is for a `Row`, where the cross axis is vertical. `alignSelf`
   * OVERRIDES the parent's `alignItems: 'center'`, so on a row stretched to a
   * 44pt touch target the default pins the pill to the top, well above the
   * text it labels.
   *
   * Deliberately a narrow enum rather than the `style` passthrough Button and
   * Icon take: Badge owns its colors from theme tokens, and `board/labelFit.ts`
   * hardcodes this pill's padding to predict TaskCard's label row, so a caller
   * able to restyle either one would break something silently.
   */
  align?: 'start' | 'center';
  testID?: string;
}

export function Badge({
  label,
  color = 'secondary',
  outlined = true,
  shape = 'rect',
  icon,
  compact = false,
  align = 'start',
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
      style={{
        // Shrink-wrap by default; `center` for a Row. See BadgeProps.align.
        alignSelf: align === 'center' ? 'center' : 'flex-start',
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
      }}
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
  iconRow: {
    alignItems: 'center',
  },
});
