import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Badge, Icon, Row, Text, useTheme } from '@/components';
import type { Theme } from '@/components/theme/tokens';
import { relativeTimeLabel } from '@/lib/relativeTime';
import type { TurnMeta } from '@/conversation/transcriptCells';

export interface TurnFrameProps {
  turn: TurnMeta;
  children: React.ReactNode;
}

function bandColors(theme: Theme, role: TurnMeta['role']): { backgroundColor: string; borderColor: string } {
  if (role === 'user') {
    return { backgroundColor: theme.colors.accentSubtle, borderColor: theme.colors.accentMuted };
  }
  return { backgroundColor: theme.colors.surface, borderColor: theme.colors.border };
}

/**
 * One bordered card per conversation TURN, not per block: every cell that
 * belongs to the same assistant (or user) entry shares this same band -
 * `first`/`last` own the rounded corners and outer edge borders, `middle`
 * cells are borderless top/bottom so the run reads as one seamless card.
 * This is what lets bare text and a nested tool-call card coexist in one
 * turn without the "pill vs. plain paragraph" mismatch.
 */
export function TurnFrame({ turn, children }: TurnFrameProps): React.JSX.Element {
  const theme = useTheme();
  const { backgroundColor, borderColor } = bandColors(theme, turn.role);
  const isFirst = turn.position === 'solo' || turn.position === 'first';
  const isLast = turn.position === 'solo' || turn.position === 'last';

  return (
    <View
      style={[
        styles.band,
        {
          backgroundColor,
          borderColor,
          marginHorizontal: theme.spacing.md,
          marginTop: isFirst ? theme.spacing.sm : 0,
          marginBottom: isLast ? theme.spacing.sm : 0,
          borderTopWidth: isFirst ? StyleSheet.hairlineWidth : 0,
          borderBottomWidth: isLast ? StyleSheet.hairlineWidth : 0,
          borderTopLeftRadius: isFirst ? theme.radii.md : 0,
          borderTopRightRadius: isFirst ? theme.radii.md : 0,
          borderBottomLeftRadius: isLast ? theme.radii.md : 0,
          borderBottomRightRadius: isLast ? theme.radii.md : 0,
          paddingHorizontal: theme.spacing.md,
          paddingTop: isFirst ? theme.spacing.sm : theme.spacing.xs,
          paddingBottom: isLast ? theme.spacing.sm : theme.spacing.xs,
        },
      ]}
    >
      {turn.header !== undefined ? <TurnHeader role={turn.role} header={turn.header} /> : null}
      {children}
    </View>
  );
}

/** "↓ 1.2k" / "↓ 640": the tokens this turn wrote, compact enough for the header row. */
function formatOutputTokens(outputTokens: number): string {
  return outputTokens >= 1000 ? `↓ ${(outputTokens / 1000).toFixed(1)}k` : `↓ ${outputTokens}`;
}

/**
 * A role badge (icon + "You" / the agent's name) makes who-said-this an
 * explicit label rather than a color-only cue - the desktop Conversations
 * tab does the same (a role pill on every turn, not just a tint).
 */
function TurnHeader({
  role,
  header,
}: {
  role: TurnMeta['role'];
  header: NonNullable<TurnMeta['header']>;
}): React.JSX.Element {
  const theme = useTheme();
  const isUser = role === 'user';
  const roleColor = isUser ? ('accent' as const) : ('secondary' as const);
  // Date.now() is impure to call directly during render (react-hooks/purity) -
  // a lazy initializer runs once at mount instead, which is enough for a
  // transcript timestamp: it doesn't need to keep ticking like a live feed.
  const [renderedAtMs] = useState(() => Date.now());
  return (
    <Row gap="xs" style={{ marginBottom: theme.spacing.xs }}>
      <Badge
        testID={`turn-role-${role}`}
        label={isUser ? 'You' : (header.agentName ?? 'Agent')}
        color={roleColor}
        shape="pill"
        icon={<Icon name={isUser ? 'user' : 'agent'} size={12} color={roleColor} />}
      />
      {header.model !== null ? (
        <Text variant="caption" color="muted" numberOfLines={1} style={styles.headerModel}>
          {header.model}
        </Text>
      ) : null}
      {header.outputTokens !== null ? (
        <Text variant="caption" color="muted" numberOfLines={1} testID="turn-output-tokens">
          {formatOutputTokens(header.outputTokens)}
        </Text>
      ) : null}
      <View style={styles.flex} />
      {/* flexShrink: 0 + numberOfLines: 1 guarantee the timestamp never wraps
          or gets clipped - the badge/model above give way first. */}
      <Text variant="caption" color="muted" numberOfLines={1} style={styles.headerTime}>
        {relativeTimeLabel(header.ts, renderedAtMs)}
      </Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  band: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  headerModel: {
    flexShrink: 1,
  },
  headerTime: {
    flexShrink: 0,
  },
  flex: {
    flex: 1,
    minWidth: 0,
  },
});
