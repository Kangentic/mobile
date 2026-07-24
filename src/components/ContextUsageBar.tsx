import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { SessionUsageWire } from '@kangentic/protocol';
import { Row } from './Row';
import { Text } from './Text';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/tokens';

export interface ContextUsageBarProps {
  /** Null (or an unknown window - see below) renders nothing. */
  usage: SessionUsageWire | null;
  testID?: string;
}

/**
 * Context-usage tint thresholds. Three discrete bands, not a gradient: a
 * gradient blends into an ambiguous midpoint exactly where the user most
 * needs a clear read.
 *
 * Mirrored in the desktop `Kangentic` repo's
 * `src/renderer/utils/progress-color.ts` (`getProgressColor`): same
 * thresholds, same roles. Nothing checks the two repos against each other,
 * so treat that as a starting point, not a contract - the desktop side
 * says the same thing from its end.
 */
export function contextUsageColor(theme: Theme, usedPercentage: number): string {
  if (usedPercentage >= 90) return theme.colors.danger;
  if (usedPercentage >= 70) return theme.colors.warning;
  return theme.colors.statusWorking;
}

/**
 * Whether a usage report has a known context window - the render gate. A
 * size of 0 is the desktop's "unknown size" sentinel, sent before any
 * window has been learned for a session's model. Exported so a parent
 * (TaskCard) can decide layout - whether to render its bordered utility
 * strip at all - without duplicating the check.
 *
 * This and the two functions below port the desktop `Kangentic` repo's
 * `src/renderer/utils/format-tokens.ts` trio (same names, same semantics),
 * shared there by its own TaskCard and ContextBar so those two surfaces
 * cannot drift on what counts as renderable.
 */
export function isContextWindowKnown(usage: SessionUsageWire | null): usage is SessionUsageWire {
  return usage !== null && usage.contextWindow.contextWindowSize > 0;
}

/**
 * True when usedTokens exceeds a known window - occupancy at or past
 * auto-compaction. This is a legitimate critical state, not bad data: the
 * desktop merge path (Kangentic's UsageAccumulator.setSessionUsage) already
 * degrades an untrustworthy over-budget pairing to the zero-window sentinel
 * before it ever reaches this app's wire, so an over-budget payload that
 * does arrive here can only have come from an authoritative snapshot (a
 * live status.json read, that repo's UsageAccumulator.replaceSessionUsage,
 * which deliberately leaves an over-budget pairing intact). Paint a full
 * critical bar rather than hiding it.
 */
function isContextWindowOverBudget(usage: SessionUsageWire): boolean {
  return isContextWindowKnown(usage) && usage.contextWindow.usedTokens > usage.contextWindow.contextWindowSize;
}

/**
 * The clamped context-window percentage to display: 0 for an unknown
 * window (no denominator - callers still gate the render on
 * isContextWindowKnown), 100 for an over-budget one (the near-full /
 * auto-compaction critical state), otherwise the reported percentage
 * rounded and capped at 100. The cap is load-bearing, not decorative: the
 * authoritative used_percentage can exceed 100 against an
 * auto-compact-adjusted denominator even while usedTokens still fits the
 * window.
 */
export function contextWindowDisplayPercent(usage: SessionUsageWire): number {
  if (!isContextWindowKnown(usage)) return 0;
  if (isContextWindowOverBudget(usage)) return 100;
  return Math.min(100, Math.round(usage.contextWindow.usedPercentage));
}

/**
 * The model + context-window bar shared by the board's task cards and the
 * Agents feed rows: model name and used percent on one line (both muted -
 * secondary to the card's own content, never competing with it), the bar
 * full-width beneath. No divider or top padding of its own - the parent
 * (a task card's utility strip) owns the divider above it. Renders nothing
 * when the session reports no usage yet, or the window size is unknown -
 * a full critical bar still renders when usage is over budget, desktop
 * parity for "a near-full session shows a full critical bar, not nothing".
 */
export function ContextUsageBar({ usage, testID }: ContextUsageBarProps): React.JSX.Element | null {
  const theme = useTheme();
  if (!isContextWindowKnown(usage)) return null;
  const usedPercentage = contextWindowDisplayPercent(usage);

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityLabel={`${usage.model.displayName}, context window ${usedPercentage}% used`}
      accessibilityValue={{ min: 0, max: 100, now: usedPercentage }}
    >
      <Row gap="sm" style={styles.spaceBetween}>
        <Text variant="caption" color="muted">
          {usage.model.displayName}
        </Text>
        <Text variant="caption" color="muted">
          {usedPercentage}%
        </Text>
      </Row>
      <View style={[styles.track, { backgroundColor: theme.colors.border, marginTop: theme.spacing.xs }]}>
        <View
          testID={testID === undefined ? undefined : `${testID}-fill`}
          style={[styles.fill, { backgroundColor: contextUsageColor(theme, usedPercentage), width: `${usedPercentage}%` }]}
        />
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
