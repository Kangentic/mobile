import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Folder } from 'lucide-react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { Text, useTheme } from '@/components';
import { isDoneRole, isTodoRole } from '@/state/boardStore';
import { getColumnIcon } from './columnIcons';
import type { ColumnTrackStep } from './columnTrack';

/*
 * The band's frame and track are the desktop's own measurements, copied 1:1
 * from the workflow card strip (kangentic #732, WorkflowStrip.tsx /
 * WorkflowCanvasCard.tsx), and the project half is #732's project row. They are
 * deliberately literal rather than spacing tokens: the token scale has no 5 or
 * 10, and rounding to it is exactly the drift this component exists to avoid.
 *
 * The current step's marker is this app's design (2026-10-05 design review,
 * "D5"), and #732 was asked to adopt it: the column's icon in an 18 dp rounded
 * square tinted with the column's color, in place of the desktop's wider bar.
 */
export const COLUMN_STRIP_HEIGHT = 29;
const STRIP_INSET = 10;
const STRIP_GAP_BELOW = 8;
const STRIP_GROUP_GAP = 8;
const PROJECT_ICON_SIZE = 12;
const PROJECT_ICON_GAP = 6;
const GLYPH_SIZE = 12;
const GLYPH_STROKE = 1.75;
/** The Board chip bar's and session header's dot (ColumnChipBar, TaskHeader), so the fallback is one shape everywhere. */
const DOT_SIZE = 8;
const MARKER_SIZE = 18;
const MARKER_RADIUS = 5;
/** The desktop current-step ring's own tint strength, kept for the marker that replaces it. */
const MARKER_TINT_OPACITY = 0.18;
const TRACK_GAP = 2;
const SEGMENT_WIDTH = 11;
const SEGMENT_HEIGHT = 4;
const DONE_SEGMENT_OPACITY = 0.55;

export interface ColumnStripProps {
  /** The task's column, or null when no cached board resolves it - the strip then draws no marker, never a guessed column. */
  column: BoardColumnWire | null;
  /** The step track (see buildPositionalTrack); empty means the column is not a working column, and its marker stands alone. */
  track: readonly ColumnTrackStep[];
  /** Where the task lives. Known from the session even before its task reaches a board, so the band is rarely empty. */
  projectName: string | null;
  /** Root testID; parts key off it as `-project`, `-track`, `-marker` (holding `-icon` or `-dot`), and `-step-<columnId>-<done|ahead>`. */
  testID: string;
}

/**
 * The Agents row's top band: where the task lives on the left (the project),
 * where it is in the flow on the right (the step track, its current step
 * marked by the column's own icon). The desktop's rule for its strip carries
 * over: new information goes in this band, never into the card rows under it,
 * which is why the project left the title row for it.
 *
 * The column is never named in words here. The review compared a name beside
 * the track and chose the quieter band: the icon, its color and its place in
 * the track say which column, the session header's chip names it one tap
 * away, and a screen reader hears it from this band's label.
 *
 * FIXED GEOMETRY. The band is the same height on every branch, including the
 * one with nothing to mark. A row whose task has not reached a board yet (the
 * feed's fallback stand-in) still draws the band: dropping it would grow the
 * row by the band's height the moment the board landed and shift every card
 * below it, which is the movement the row's fixed snippet slot already exists
 * to prevent. The desktop never drops its strip either.
 *
 * It drops the marker on "no column resolves", never on a session swap: a
 * column move IS a swap, and that is precisely when the new column should show.
 *
 * Static by design - no animated hooks. The feed is a 100-times-a-day surface
 * (motion-conventions.md), and every registered mapper costs idle CPU per row.
 */
export const ColumnStrip = React.memo(function ColumnStrip({
  column,
  track,
  projectName,
  testID,
}: ColumnStripProps): React.JSX.Element {
  const theme = useTheme();
  const visibleSteps = track.filter((step) => step.state !== 'skipped');
  return (
    <View
      testID={testID}
      accessibilityLabel={stripAccessibilityLabel(projectName, column, visibleSteps)}
      style={[
        styles.strip,
        {
          // Flush to the card's edges: the card pads its content by md, so the
          // band cancels it on three sides and the top corners follow the
          // card's own (inner) radius.
          marginTop: -theme.spacing.md,
          marginHorizontal: -theme.spacing.md,
          borderTopLeftRadius: theme.radii.md - StyleSheet.hairlineWidth,
          borderTopRightRadius: theme.radii.md - StyleSheet.hairlineWidth,
          backgroundColor: theme.colors.surfaceInset,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      {projectName !== null ? (
        <View style={styles.project}>
          <Folder size={PROJECT_ICON_SIZE} color={theme.colors.textSecondary} />
          <Text variant="caption" color="primary" numberOfLines={1} style={styles.projectName} testID={`${testID}-project`}>
            {projectName}
          </Text>
        </View>
      ) : null}
      {column !== null ? (
        <View testID={`${testID}-track`} style={styles.track}>
          {visibleSteps.length === 0
            ? columnMarker(column, theme.colors.textMuted, testID)
            : visibleSteps.map((step) =>
                step.state === 'current' ? (
                  <React.Fragment key={step.columnId}>{columnMarker(column, theme.colors.textMuted, testID)}</React.Fragment>
                ) : (
                  <View
                    key={step.columnId}
                    testID={`${testID}-step-${step.columnId}-${step.state}`}
                    style={[
                      styles.segment,
                      step.state === 'done'
                        ? { backgroundColor: colorOrFaint(step.color, theme.colors.textMuted), opacity: DONE_SEGMENT_OPACITY }
                        : { backgroundColor: theme.colors.border },
                    ]}
                  />
                ),
              )}
        </View>
      ) : null}
    </View>
  );
});

/**
 * The current step: the column's glyph in a rounded square tinted with the
 * column's color. The glyph keeps the priority every other column surface in
 * the app uses (the Board's chip bar, the session header chip): the column's
 * own icon, else its role default, else a dot in the column's color.
 *
 * To Do and Done draw uncolored (the faint text color), as the desktop strip
 * draws them; they are never in the track, so their marker always stands alone.
 *
 * A plain function, not a component: the glyph is a stable module-level entry
 * of columnIcons' registry, but the React Compiler's static-components rule
 * cannot see that through a function call and reads it as a component created
 * during render. (ColumnChipBar and TaskHeader make the same lookup inside a
 * callback, where the rule does not look.)
 */
function columnMarker(column: BoardColumnWire, faintColor: string, stripTestID: string): React.JSX.Element {
  const ColumnIcon = getColumnIcon(column);
  const isSystemRole = isTodoRole(column.role) || isDoneRole(column.role);
  const markerColor = isSystemRole ? faintColor : colorOrFaint(column.color, faintColor);
  return (
    <View testID={`${stripTestID}-marker`} style={styles.marker}>
      <View style={[styles.markerTint, { backgroundColor: markerColor }]} />
      {/* The testID rides a wrapping View: lucide forwards `testID` as the
          web-only `data-testid`, which neither RNTL nor Maestro can select. */}
      {ColumnIcon !== null ? (
        <View testID={`${stripTestID}-icon`}>
          <ColumnIcon size={GLYPH_SIZE} color={markerColor} strokeWidth={GLYPH_STROKE} />
        </View>
      ) : (
        <View testID={`${stripTestID}-dot`} style={[styles.dot, { backgroundColor: markerColor }]} />
      )}
    </View>
  );
}

/**
 * What a screen reader hears for the band. The card is one pressable element,
 * so this joins the card's own spoken label; it carries the column's name,
 * which the band never draws.
 */
function stripAccessibilityLabel(
  projectName: string | null,
  column: BoardColumnWire | null,
  visibleSteps: readonly ColumnTrackStep[],
): string | undefined {
  // The step is announced only beside the column it belongs to: with no column
  // the band draws no track, so a step count would describe nothing on screen.
  const currentStepIndex = column === null ? -1 : visibleSteps.findIndex((step) => step.state === 'current');
  const parts = [
    projectName,
    column?.name ?? null,
    currentStepIndex === -1 ? null : `step ${currentStepIndex + 1} of ${visibleSteps.length}`,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** Column colors are desktop-authored data; an empty one falls back to the faint text color, as the desktop's `?? fg-faint` does. */
function colorOrFaint(columnColor: string, faintColor: string): string {
  return columnColor.length > 0 ? columnColor : faintColor;
}

const styles = StyleSheet.create({
  strip: {
    height: COLUMN_STRIP_HEIGHT,
    marginBottom: STRIP_GAP_BELOW,
    paddingHorizontal: STRIP_INSET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: STRIP_GROUP_GAP,
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  project: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: PROJECT_ICON_GAP,
    flexShrink: 1,
    minWidth: 0,
  },
  projectName: {
    flexShrink: 1,
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: TRACK_GAP,
    flexShrink: 0,
    // Pinned right even when there is no project to push it there.
    marginLeft: 'auto',
  },
  segment: {
    width: SEGMENT_WIDTH,
    height: SEGMENT_HEIGHT,
    borderRadius: SEGMENT_HEIGHT / 2,
  },
  marker: {
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    borderRadius: MARKER_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerTint: {
    ...StyleSheet.absoluteFill,
    borderRadius: MARKER_RADIUS,
    opacity: MARKER_TINT_OPACITY,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
});
