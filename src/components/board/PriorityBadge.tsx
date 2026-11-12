import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Flag } from 'lucide-react-native';
import type { PriorityLevelWire } from '@kangentic/protocol';
import { Row } from '../Row';
import { Text } from '../Text';
import { TINTED_PILL_EDGE_ALPHA, TINTED_PILL_FILL_ALPHA, hexWithAlpha } from '../theme/color';
import { useTheme } from '../theme/ThemeProvider';
import { PRIORITY_BADGE_FLAG_SIZE } from './labelFit';

/**
 * A task's priority as the desktop card draws it (protocol 0.28.0, kangentic
 * 6bc394e19): the first pill in the labels row, a flag and the level's name,
 * both in the level's color over a tint of it. Pass only a level
 * `priorityLevelFor` returned, which already leaves out the bottom of the
 * scale.
 *
 * Square-cornered like the phone's label pills beside it (`Badge`), where the
 * desktop's pills are round: the row reads as one family either way, and on
 * the phone that family is square. Same height as a label pill, so
 * `board/labelFit.ts` can count it (`priorityBadgeReserve`), which owns the
 * flag size so its estimate and this drawing cannot drift apart.
 */
export function PriorityBadge({ level, testID }: { level: PriorityLevelWire; testID?: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={`Priority: ${level.label}`}
      style={[
        styles.pill,
        {
          backgroundColor: hexWithAlpha(level.color, TINTED_PILL_FILL_ALPHA),
          borderColor: hexWithAlpha(level.color, TINTED_PILL_EDGE_ALPHA),
          borderRadius: theme.radii.sm,
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: theme.spacing.xs / 2,
        },
      ]}
    >
      <Row gap="xs" style={styles.content}>
        <Flag size={PRIORITY_BADGE_FLAG_SIZE} color={level.color} />
        <Text variant="caption" numberOfLines={1} style={[styles.label, { color: level.color }]}>
          {level.label}
        </Text>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 0,
  },
  content: {
    alignItems: 'center',
  },
  label: {
    fontWeight: '500',
  },
});
