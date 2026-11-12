import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Flag } from 'lucide-react-native';
import type { PriorityLevelWire } from '@kangentic/protocol';
import { Row } from '../Row';
import { Text } from '../Text';
import { hexWithAlpha } from '../theme/color';
import { useTheme } from '../theme/ThemeProvider';

/** The desktop pill's flag (PriorityBadge.tsx: lucide Flag at 12). */
const FLAG_SIZE = 12;
/** The desktop's tinted pill: the level's color at 14% for the fill and 35% for the edge. */
const FILL_ALPHA = 0.14;
const EDGE_ALPHA = 0.35;

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
 * `board/labelFit.ts` can count it (`estimatePriorityBadgeWidth`).
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
          backgroundColor: hexWithAlpha(level.color, FILL_ALPHA),
          borderColor: hexWithAlpha(level.color, EDGE_ALPHA),
          borderRadius: theme.radii.sm,
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: theme.spacing.xs / 2,
        },
      ]}
    >
      <Row gap="xs" style={styles.content}>
        <Flag size={FLAG_SIZE} color={level.color} />
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
