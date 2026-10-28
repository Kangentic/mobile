import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { TaskReportRouteColumnWire } from '@kangentic/protocol';
import { Text, contrastRatio, parseHexColor, useTheme, type Theme } from '@/components';
import { getColumnIcon } from '@/components/board/columnIcons';
import { formatMonthDayTime, formatSpanCompact } from '@/taskReport/format';
import { ReportCard } from './ReportCard';

const DISC_SIZE = 22;
const DISC_ICON_SIZE = 12;
const NAME_WIDTH = 96;
const TIME_WIDTH = 60;
const ROW_HEIGHT = 28;
const STAY_ROW_HEIGHT = 22;
const BAR_HEIGHT = 10;
const BAR_RADIUS = 3;
/** A column with almost no time still shows a sliver, so its color is findable. */
const BAR_MIN_WIDTH = 3;
/** The desktop lists a column's stays only when it has two or more of at least a minute (`VISIT_CARD_MIN_MS`). */
const STAY_MIN_MS = 60_000;

/** Ink or cream on the column's color, whichever reads better: the desktop's black-or-white-by-contrast rule in the brand's own ink and cream. */
function glyphColorOn(columnColor: string, theme: Theme): string {
  const background = parseHexColor(columnColor);
  const ink = parseHexColor(theme.brand.ink);
  const cream = parseHexColor(theme.brand.cream);
  if (background === null || ink === null || cream === null) return theme.brand.cream;
  return contrastRatio(background, ink) >= contrastRatio(background, cream) ? theme.brand.ink : theme.brand.cream;
}

/**
 * The time the task spent in each working column, in board order (approved
 * design G1). The desktop draws one row of pills sized by their share of the
 * time; five do not fit their names in a phone's width, so each column gets a
 * row of its own and a bar scaled to the longest column. Same colors, icons
 * and times. Display only: the desktop's pill opens that part of the
 * conversation, which the phone cannot jump to.
 */
export function RouteCard({ route }: { route: TaskReportRouteColumnWire[] }): React.JSX.Element {
  const theme = useTheme();
  const longestMs = Math.max(1, ...route.map((column) => column.totalMs));
  return (
    <ReportCard title="Route" testID="completed-summary-route">
      <View>
        {route.map((column) => {
          const ColumnIcon = getColumnIcon(column);
          const stays = column.visits.filter((visit) => visit.durationMs >= STAY_MIN_MS);
          const barShare = Math.max(0, column.totalMs) / longestMs;
          return (
            <View key={column.swimlaneId} testID={`completed-summary-route-${column.swimlaneId}`}>
              <View
                style={[styles.row, { gap: theme.spacing.sm }]}
                accessible
                accessibilityLabel={`${column.name}, ${formatSpanCompact(column.totalMs)}`}
              >
                <View style={[styles.disc, { backgroundColor: column.color }]}>
                  {ColumnIcon !== null ? <ColumnIcon size={DISC_ICON_SIZE} color={glyphColorOn(column.color, theme)} strokeWidth={2} /> : null}
                </View>
                <Text numberOfLines={1} style={styles.name}>
                  {column.name}
                </Text>
                <View style={styles.track}>
                  <View style={[styles.bar, { width: `${barShare * 100}%`, backgroundColor: column.color }]} />
                </View>
                <Text color="secondary" style={styles.time}>
                  {formatSpanCompact(column.totalMs)}
                </Text>
              </View>
              {stays.length >= 2
                ? stays.map((visit) => (
                    <View key={visit.startedAt} style={[styles.stay, { gap: theme.spacing.sm }]}>
                      <View style={styles.discSpacer} />
                      <Text variant="caption" color="muted" style={styles.stayStart}>
                        {formatMonthDayTime(visit.startedAt)}
                      </Text>
                      <Text variant="caption" color="secondary" style={styles.time}>
                        {formatSpanCompact(visit.durationMs)}
                      </Text>
                    </View>
                  ))
                : null}
            </View>
          );
        })}
      </View>
    </ReportCard>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    height: ROW_HEIGHT,
  },
  disc: {
    alignItems: 'center',
    borderRadius: DISC_SIZE / 2,
    height: DISC_SIZE,
    justifyContent: 'center',
    width: DISC_SIZE,
  },
  discSpacer: {
    width: DISC_SIZE,
  },
  name: {
    width: NAME_WIDTH,
  },
  track: {
    flex: 1,
    minWidth: 0,
  },
  bar: {
    borderRadius: BAR_RADIUS,
    height: BAR_HEIGHT,
    minWidth: BAR_MIN_WIDTH,
  },
  time: {
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    width: TIME_WIDTH,
  },
  stay: {
    alignItems: 'center',
    flexDirection: 'row',
    height: STAY_ROW_HEIGHT,
  },
  stayStart: {
    flex: 1,
    minWidth: 0,
  },
});
