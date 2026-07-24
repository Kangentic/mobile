import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { SessionUsageWire } from '@kangentic/protocol';
import { Row } from './Row';
import { Text } from './Text';
import { useTheme } from './theme/ThemeProvider';

export interface ContextUsageBarProps {
  /** Null (or an untrustworthy window - see below) renders nothing. */
  usage: SessionUsageWire | null;
  testID?: string;
}

/** Context-usage tint thresholds, mirroring the desktop card's progress color ramp. */
function contextUsageColor(theme: ReturnType<typeof useTheme>, usedPercentage: number): string {
  if (usedPercentage >= 90) return theme.colors.danger;
  if (usedPercentage >= 70) return theme.colors.warning;
  return theme.colors.statusWorking;
}

/**
 * Whether a usage report is trustworthy enough to render - a sane window
 * size the used tokens could fit inside. Exported so a parent (TaskCard)
 * can decide layout - whether to render its bordered utility strip at all -
 * without duplicating the check.
 */
export function isUsageTrusted(usage: SessionUsageWire | null): usage is SessionUsageWire {
  return usage !== null && usage.contextWindow.contextWindowSize > 0 && usage.contextWindow.usedTokens <= usage.contextWindow.contextWindowSize;
}

/**
 * The model + context-window bar shared by the board's task cards and the
 * Agents feed rows: model name and used percent on one line (both muted -
 * secondary to the card's own content, never competing with it), the bar
 * full-width beneath. No divider or top padding of its own - the parent
 * (a task card's utility strip) owns the divider above it. Renders nothing
 * when the session reports no usage yet, or fails isUsageTrusted - desktop
 * parity for "don't show a bar we don't trust".
 */
export function ContextUsageBar({ usage, testID }: ContextUsageBarProps): React.JSX.Element | null {
  const theme = useTheme();
  if (!isUsageTrusted(usage)) return null;
  const usedPercentage = Math.round(usage.contextWindow.usedPercentage);

  return (
    <View testID={testID}>
      <Row gap="sm" style={styles.spaceBetween}>
        <Text variant="caption" color="muted">
          {usage.model.displayName}
        </Text>
        <Text variant="caption" color="muted">
          {usedPercentage}%
        </Text>
      </Row>
      <View style={[styles.track, { backgroundColor: theme.colors.border, marginTop: theme.spacing.xs }]}>
        <View style={[styles.fill, { backgroundColor: contextUsageColor(theme, usedPercentage), width: `${usedPercentage}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  spaceBetween: {
    justifyContent: 'space-between',
  },
  track: {
    borderRadius: 2,
    height: 4,
    overflow: 'hidden',
  },
  fill: {
    borderRadius: 2,
    height: '100%',
  },
});
