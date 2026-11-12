import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Gauge } from 'lucide-react-native';
import type { BoardColumnWire, BoardTaskQueuePlaceWire } from '@kangentic/protocol';
import { Row, Stack, Text, useTheme } from '@/components';
import { getColumnIcon } from '@/components/board/columnIcons';
import { TINTED_PILL_EDGE_ALPHA, TINTED_PILL_FILL_ALPHA, hexWithAlpha } from '@/components/theme/color';
import { queuedCount, queuedHeading, queuedReason } from '@/lib/queuePlace';

/** The desktop's reason-line glyph size (QueueReason: Gauge / SwimlaneIcon at 16). */
const REASON_GLYPH_SIZE = 16;
/** The desktop's column dot (`w-2.5 h-2.5`), for a column with no icon. */
const REASON_DOT_SIZE = 10;
/** Where the heading sits: the desktop puts it 14% down its window; on a phone's lens that is about 64 pt. */
const PANEL_TOP_INSET = 64;

/**
 * What the terminal lens shows for a QUEUED session (protocol 0.28.0): the
 * desktop's queued task window (`QueuedPlaceholder.tsx`) as far as the wire
 * carries it. A heading in the card's words without the dots ("Next in line",
 * "2 tasks ahead", "Queued"), the "{position} of {total}" pill, and what holds
 * the task: its column's limit, with the column's icon, or the desktop's Max
 * concurrent sessions, with a gauge.
 *
 * Not drawn, because the wire leaves it out on purpose: the desktop's
 * numbered line of the tasks ahead. And the reason line is plain text: on the
 * desktop it opens the column manager or Settings, which the phone has neither
 * of. Drawn over the terminal pane, as the Resume panel is, because the xterm
 * WebView must never unmount; a queued session has no PTY to show anyway.
 */
export function QueuedPanel({
  place,
  column,
}: {
  place: BoardTaskQueuePlaceWire | null;
  /** The task's own column, for the reason line's icon: a column limit always holds the task in its own column. */
  column: BoardColumnWire | null;
}): React.JSX.Element {
  const theme = useTheme();
  const heading = queuedHeading(place);
  const count = queuedCount(place);
  const reason = queuedReason(place);
  const countColor = theme.colors.textSecondary;

  return (
    <View
      testID="session-queued-panel"
      style={[styles.panel, { backgroundColor: theme.colors.background, paddingHorizontal: theme.spacing.lg, paddingTop: PANEL_TOP_INSET }]}
    >
      <Stack gap="md" style={styles.content}>
        <Row gap="md" style={styles.centerRow}>
          <Text variant="heading" testID="session-queued-heading">
            {heading}
          </Text>
          {count !== null ? (
            <View
              testID="session-queued-count"
              style={[
                styles.countPill,
                {
                  borderRadius: theme.radii.full,
                  paddingHorizontal: theme.spacing.sm + 2,
                  // The desktop's tinted pill, of the text color.
                  backgroundColor: hexWithAlpha(countColor, TINTED_PILL_FILL_ALPHA),
                  borderColor: hexWithAlpha(countColor, TINTED_PILL_EDGE_ALPHA),
                },
              ]}
            >
              <Text variant="caption" color="secondary" style={styles.countText}>
                {count}
              </Text>
            </View>
          ) : null}
        </Row>
        {reason !== null ? (
          <Row gap="xs" style={styles.centerRow} testID="session-queued-reason">
            {reason.kind === 'global' ? (
              <Gauge size={REASON_GLYPH_SIZE} color={theme.colors.textSecondary} />
            ) : column !== null ? (
              columnGlyph(column)
            ) : null}
            <Text color="secondary" style={styles.reasonText}>
              {reason.text}
            </Text>
          </Row>
        ) : null}
      </Stack>
    </View>
  );
}

/**
 * The column's glyph for the reason line, as the desktop's SwimlaneIcon draws
 * it: the column's icon in its color, else a dot in its color. A plain function
 * rather than a component, as ColumnChip's `columnGlyph` is: the icon is a
 * stable entry of columnIcons' registry, but the React Compiler's
 * static-components rule cannot see that through a function call.
 */
function columnGlyph(column: BoardColumnWire): React.JSX.Element | null {
  const ColumnIcon = getColumnIcon(column);
  if (ColumnIcon !== null) return <ColumnIcon size={REASON_GLYPH_SIZE} color={column.color} strokeWidth={1.75} />;
  if (column.color) return <View style={[styles.columnDot, { backgroundColor: column.color }]} />;
  return null;
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    zIndex: 2,
  },
  content: {
    alignItems: 'center',
  },
  centerRow: {
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
  countPill: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: 3,
  },
  countText: {
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  columnDot: {
    width: REASON_DOT_SIZE,
    height: REASON_DOT_SIZE,
    borderRadius: REASON_DOT_SIZE / 2,
  },
  reasonText: {
    textAlign: 'center',
    flexShrink: 1,
  },
});
