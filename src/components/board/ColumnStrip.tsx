import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Folder } from 'lucide-react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { Text, useTheme } from '@/components';
import { CARD_STRIP_GROUP_GAP, CARD_STRIP_HEIGHT, CardStrip } from './CardStrip';
import { getColumnIcon } from './columnIcons';
import type { ColumnTrackStep } from './columnTrack';
import { WaitLabel } from './WaitLabel';
import type { WorkflowStripLabel } from '@/workflow/workflowState';
import { WorkflowGlyph } from './WorkflowGlyph';

/*
 * The band's contents and track are the desktop's own measurements, copied 1:1
 * from the workflow card strip (kangentic #732, WorkflowStrip.tsx /
 * WorkflowCanvasCard.tsx), and the project half is #732's project row. Its
 * look is the shared CardStrip's, and its place on the card is the
 * CardStripBleed the card wraps it in. They are deliberately literal rather
 * than spacing tokens: the token scale has no 5 or 10, and rounding to it is
 * exactly the drift this component exists to avoid.
 *
 * The track is the one the desktop approved on 2026-10-07 (#732's design
 * canvas, sign-off row T2): the task's whole journey from To Do to Done, one
 * mark per stop. The stop the task is at is its column's icon in an 18 dp
 * rounded square tinted with the column's color, To Do and Done included.
 * Passed stops are neutral, and stops ahead carry their own column's color,
 * faded, so a card that has not started already says where it will go.
 */
export const COLUMN_STRIP_HEIGHT = CARD_STRIP_HEIGHT;
const PROJECT_ICON_SIZE = 12;
const PROJECT_ICON_GAP = 6;
/** The desktop board strip's workflow label (WorkflowTaskCardBody.tsx): a 12 glyph and a 5 gap. */
const WORKFLOW_ICON_SIZE = 12;
const WORKFLOW_LABEL_GAP = 5;
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
/** The desktop's ahead bar is `color-mix(<column color> 45%, transparent)`; on a childless View, opacity is the same thing. */
const AHEAD_SEGMENT_OPACITY = 0.45;

/** The workflow a strip names on its left, as the desktop's board strip does (protocol 0.21.0). */
export type StripWorkflow = WorkflowStripLabel;

export interface ColumnStripProps {
  /** The task's column, or null when no cached board resolves it - the strip then draws no marker, never a guessed column. */
  column: BoardColumnWire | null;
  /** The journey track (see buildJourneyTrack); empty means the column is not a stop of the journey (an archived or ghost column), and its marker stands alone. */
  track: readonly ColumnTrackStep[];
  /** Where the task lives. Known from the session even before its task reaches a board, so the band is rarely empty. */
  projectName: string | null;
  /**
   * The task's workflow, which takes the left side in place of the project
   * (design screen 1, decision A1): the workflow's glyph in its color and its
   * name. The project is then only spoken. Absent or null for an ordinary task,
   * and in the workflow view, whose cards name their project as the desktop's
   * canvas does.
   *
   * No pause glyph while the workflow is paused, as the desktop draws none on
   * either of its cards since kangentic #877 (signed off 2026-10-21: at 11 px
   * it read as stray bars). A paused workflow is still spoken here, and a
   * paused task in To Do says Paused in its footer.
   */
  workflow?: StripWorkflow | null;
  /**
   * Epoch ms this session first needed the user (`selectWaitingSince`), or null
   * when it is working. Drawn just before the track; see the band's doc for why
   * it lives here rather than at the end of the body line.
   */
  waitingSinceMs: number | null;
  /**
   * The wait label's testID, passed in rather than derived from `testID`: it
   * predates the band (it used to end the card's body line) and a Maestro flow
   * selects it as `<card>-wait`, so moving the label must not rename it.
   */
  waitTestID: string;
  /** Root testID; parts key off it as `-project`, `-track`, `-marker` (holding `-icon` or `-dot`), and `-step-<columnId>-<done|ahead>` (the current step is the `-marker`; a skipped step draws nothing). */
  testID: string;
  /**
   * Drawn last on the right, where a task's track goes: a Command Terminal's
   * "Command Terminal" pill (decision G1). A terminal has no column, so it
   * passes `column: null` and its band carries the pill instead of a track.
   */
  trailing?: React.ReactNode;
}

/**
 * The Agents row's column band, the card's status line: where the task lives on
 * the left (the project); how long it has waited on you, then where it is in
 * the flow, on the right (the wait time, then the step track with its current
 * step marked by the column's own icon). The desktop's rule for its strip
 * carries over: new information goes in this band, never into the card rows
 * under it, which is why the project left the title row for it.
 *
 * The wait time moved here from the end of the body line in the same review
 * that quieted the track: below the band, the card's right edge now holds a
 * single colored mark (the PR icon), and the body line gets its full width. It
 * still reads as the age of the agent's last message - a waiting session's
 * last message is the moment it started waiting - just from one line higher.
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
 * A held task's card (column automations disabled) stacks the automations
 * strip above this band, as the desktop's Agent Monitor card does (kangentic
 * #877), so it is one strip taller than its neighbours. That height follows the
 * switch, which a person flips, and the board row, which arrives with the
 * labels row and the PR chip the stand-in lacks too. Nothing the agent streams
 * moves it.
 *
 * It drops the marker on "no column resolves", never on a session swap: a
 * column move IS a swap, and that is precisely when the new column should show.
 *
 * Static by design - no animated hooks. The feed is a 100-times-a-day surface
 * (motion-conventions.md). On Reanimated 4.5.1 every registered mapper also
 * cost idle CPU per row; 4.7.1 measures them free, but the frequency gate stands.
 */
export const ColumnStrip = React.memo(function ColumnStrip({
  column,
  track,
  projectName,
  workflow = null,
  waitingSinceMs,
  waitTestID,
  testID,
  trailing,
}: ColumnStripProps): React.JSX.Element {
  const theme = useTheme();
  const visibleSteps = track.filter((step) => step.state !== 'skipped');
  return (
    <CardStrip testID={testID} accessibilityLabel={stripAccessibilityLabel(projectName, workflow, column, visibleSteps)}>
      {workflow !== null ? (
        <View style={styles.workflow} testID={`${testID}-workflow`}>
          <WorkflowGlyph colorSlot={workflow.colorSlot} size={WORKFLOW_ICON_SIZE} testID={`${testID}-workflow-glyph`} />
          <Text variant="caption" color="secondary" numberOfLines={1} style={styles.projectName} testID={`${testID}-workflow-name`}>
            {workflow.title}
          </Text>
        </View>
      ) : projectName !== null ? (
        <View style={styles.project}>
          <Folder size={PROJECT_ICON_SIZE} color={theme.colors.textSecondary} />
          <Text variant="caption" color="primary" numberOfLines={1} style={styles.projectName} testID={`${testID}-project`}>
            {projectName}
          </Text>
        </View>
      ) : null}
      <View style={styles.trailing}>
        {/* WaitLabel subscribes to the shared clock on its own, so a tick
            re-renders this leaf and not the band (see WaitLabel). It renders
            nothing for its first minute. */}
        {waitingSinceMs !== null ? <WaitLabel sinceMs={waitingSinceMs} testID={waitTestID} /> : null}
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
                        // Passed stops are neutral, the faint text color at the
                        // desktop's done-step strength; stops ahead are their
                        // own column's color, faded, so the planned route reads
                        // before the task gets there.
                        step.state === 'done'
                          ? { backgroundColor: theme.colors.textMuted, opacity: DONE_SEGMENT_OPACITY }
                          : { backgroundColor: colorOrFaint(step.color, theme.colors.textMuted), opacity: AHEAD_SEGMENT_OPACITY },
                      ]}
                    />
                  ),
                )}
          </View>
        ) : null}
        {trailing}
      </View>
    </CardStrip>
  );
});

/**
 * The current step: the column's glyph in a rounded square tinted with the
 * column's color. The glyph keeps the priority every other column surface in
 * the app uses (the Board's chip bar, the session header chip): the column's
 * own icon, else its role default, else a dot in the column's color. To Do
 * and Done are no exception: each wears its own column's color, so a finished
 * task ends on the board's Done color, not grey.
 *
 * A plain function, not a component: the glyph is a stable module-level entry
 * of columnIcons' registry, but the React Compiler's static-components rule
 * cannot see that through a function call and reads it as a component created
 * during render. (ColumnChip's `columnGlyph` does the same; TaskHeader makes the
 * lookup inside a render callback, where the rule does not look.)
 */
function columnMarker(column: BoardColumnWire, faintColor: string, stripTestID: string): React.JSX.Element {
  const ColumnIcon = getColumnIcon(column);
  const markerColor = colorOrFaint(column.color, faintColor);
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
  workflow: StripWorkflow | null,
  column: BoardColumnWire | null,
  visibleSteps: readonly ColumnTrackStep[],
): string | undefined {
  // The step is announced only beside the column it belongs to: with no column
  // the band draws no track, so a step count would describe nothing on screen.
  const currentStepIndex = column === null ? -1 : visibleSteps.findIndex((step) => step.state === 'current');
  const parts = [
    // A workflow's band draws the workflow, not the project, so the project is
    // spoken after it rather than lost.
    workflow !== null ? `Workflow ${workflow.title}${workflow.paused ? ', paused' : ''}` : null,
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
  workflow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: WORKFLOW_LABEL_GAP,
    flexShrink: 1,
    minWidth: 0,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: CARD_STRIP_GROUP_GAP,
    flexShrink: 0,
    // Pinned right even when there is no project to push it there.
    marginLeft: 'auto',
  },
  track: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: TRACK_GAP,
    flexShrink: 0,
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
