import React, { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GitMerge, GitMergeConflict, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react-native';
import type { BoardColumnWire, BoardTaskWire, SessionUsageWire } from '@kangentic/protocol';
import {
  AgentStatusIcon,
  Badge,
  Card,
  MonoText,
  Row,
  Stack,
  Text,
  useTheme,
  colorForTextRole,
  type AgentStatusKind,
} from '@/components';
import { cardStatusFooter } from './CardStatusFooter';
import type { CardSessionDisplay } from './cardSessionDisplay';
import { ColumnStrip } from './ColumnStrip';
import type { ColumnTrackStep } from './columnTrack';
import { computeVisibleLabelCount } from './labelFit';
import { prChipAccessibilityLabel, prChipPresentation, type PrChipGlyph } from './prChipPresentation';

/** Before the labels row's real width is measured (its first layout pass). */
const FALLBACK_LABEL_LIMIT = 3;

/** The PR icon's size: the card's other title-row glyphs are 14 to 16. */
const PR_GLYPH_SIZE = 14;

/**
 * The PR chip's icon for each state. A switch over static imports rather than
 * a lookup table of components, so no component is chosen at render time.
 */
function prGlyph(glyph: PrChipGlyph, color: string): React.JSX.Element {
  switch (glyph) {
    case 'merge':
      return <GitMerge size={PR_GLYPH_SIZE} color={color} />;
    case 'merge-conflict':
      return <GitMergeConflict size={PR_GLYPH_SIZE} color={color} />;
    case 'closed':
      return <GitPullRequestClosed size={PR_GLYPH_SIZE} color={color} />;
    case 'draft':
      return <GitPullRequestDraft size={PR_GLYPH_SIZE} color={color} />;
    case 'pull-request':
      return <GitPullRequest size={PR_GLYPH_SIZE} color={color} />;
  }
}

export interface TaskCardProps {
  /** Base testID; sub-parts key off it as `${testID}-status`, `-display-id`, `-pr`, `-snippet`, `-wait`, `-usage`, `-status-bar`, `-column` (whose own parts include `-column-project`). */
  testID: string;
  task: BoardTaskWire;
  /** The title row's status icon. The desktop draws one only for a running session, so callers pass null for every other `sessionDisplay`. */
  statusKind: AgentStatusKind | null;
  showTicketNumbers: boolean;
  /**
   * Which of the desktop card's session states this card is in
   * (`cardSessionDisplay`). It picks the footer: the usage bar, a status bar
   * ("Starting agent...", "Queued...", "Paused", a respawn's step), or none.
   */
  sessionDisplay: CardSessionDisplay;
  usage: SessionUsageWire | null;
  /**
   * The card's one body line: the board shows the task's own description
   * preview; the Agents feed shows a live inbox-style snippet (the pending
   * decision, or the agent's last message) instead - same slot, different
   * source, so neither screen loses its own information.
   */
  bodyText: string;
  bodyNumberOfLines?: number;
  /**
   * Fixes the body slot's height so the card NEVER changes size as its text
   * arrives or changes length. Pass the full height you want reserved
   * (typically `lineHeight * bodyNumberOfLines`): a shorter snippet is
   * centered in that box rather than collapsing it, so an async update -
   * or a live snippet growing from one line to two - moves nothing below it.
   */
  bodyMinHeight?: number;
  /**
   * The Agents feed's top band, the card's status line: the project the task
   * lives in, how long it has waited on you, and the step track with its
   * current column marked by the column's icon - the desktop's workflow card
   * strip and project row (kangentic #732) folded into one row. The desktop's
   * rule for it applies here as well: new information goes in the band, never
   * into one of the rows below it. That is why the project lives here rather
   * than as a pill in the title row, where it used to take width from the title.
   *
   * Omitted on the board, where both the project and the column are the page
   * being viewed, and whose body is the task DESCRIPTION - static because the
   * user wrote it, not because a session stalled, so a wait time beside it
   * would date the wrong thing. Present with `column: null` when the task
   * cannot be located yet: the band still draws, so the row never changes
   * height (see ColumnStrip).
   *
   * `waitingSinceMs` is `selectWaitingSince`: epoch ms the session first needed
   * the user, or null while it works. Shown at its `-wait` testID.
   */
  columnStrip?: {
    column: BoardColumnWire | null;
    track: readonly ColumnTrackStep[];
    projectName: string | null;
    waitingSinceMs: number | null;
  };
  /**
   * Whether to render board/backlog reference chrome: the labels row and
   * the title row's PR chip (same category as the ticket number).
   * Defaults true (the board).
   */
  showMetaRow?: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  /** Absolutely-positioned content painted over the whole card - the Agents feed's section-change pulse. The board has none. */
  overlay?: React.ReactNode;
}

/**
 * The task card shared by the board and the Agents feed: status icon,
 * title (with a PR chip and ticket number sharing its row), a body
 * line, the labels row, and the footer (the usage bar, or the session's state
 * as the desktop card's footer shows it: Queued, Paused, a step) - the two screens render
 * nearly identical cards. The Agents feed adds one thing: the band across the
 * top naming the project, the wait time and the column's step track.
 */
export function TaskCard({
  testID,
  task,
  statusKind,
  showTicketNumbers,
  sessionDisplay,
  usage,
  bodyText,
  bodyNumberOfLines = 2,
  bodyMinHeight,
  columnStrip,
  showMetaRow = true,
  onPress,
  onLongPress,
  overlay,
}: TaskCardProps): React.JSX.Element {
  const theme = useTheme();
  // The labels row stretches to the card's full content width regardless of
  // how many labels are inside it (a Stack's default cross-axis stretch), so
  // its first onLayout reports the real available width - reused directly
  // to decide how many labels actually fit before falling back to "+N".
  const [labelsRowWidth, setLabelsRowWidth] = useState<number | null>(null);
  const visibleLabelCount =
    labelsRowWidth === null
      ? Math.min(task.labels.length, FALLBACK_LABEL_LIMIT)
      : computeVisibleLabelCount(task.labels, labelsRowWidth);
  const visibleLabels = task.labels.slice(0, visibleLabelCount);
  const hiddenLabelCount = task.labels.length - visibleLabels.length;
  // Existence + state is what matters here (it decides whether the task is
  // ready to move to Done), not the PR number - an icon on the title row says
  // that without adding another stacked row of chrome, and without spending
  // title width on a word: its shape is the state, its color the merge verdict
  // (see prChipPresentation). The number itself is one tap away in the detail view.
  const hasPr = showMetaRow && task.pr_number !== null;
  const prChip = prChipPresentation(task.pr_state, task.pr_merge_readiness);
  const hasMetaRow = showMetaRow && task.labels.length > 0;
  const footer = cardStatusFooter({ display: sessionDisplay, usage, testID });

  return (
    <Card testID={testID} onPress={onPress} onLongPress={onLongPress}>
      {/* Outside the Stack on purpose: the band sets its own 8 below it
          (the desktop's gap), and the Stack's xs would add to that. */}
      {columnStrip ? (
        <ColumnStrip
          column={columnStrip.column}
          track={columnStrip.track}
          projectName={columnStrip.projectName}
          waitingSinceMs={columnStrip.waitingSinceMs}
          waitTestID={`${testID}-wait`}
          testID={`${testID}-column`}
        />
      ) : null}
      {/* AFTER the strip: later siblings paint on top, and the strip's fill is
          opaque, so an overlay ahead of it would tint every part of the card
          except the band. Still ahead of the Stack, so the text reads over the
          tint as it always has. */}
      {overlay}
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          {statusKind ? <AgentStatusIcon kind={statusKind} testID={`${testID}-status`} /> : null}
          {/* Desktop parity: single-line truncating title, no agent badge
              (the agent shows inside the session, not on the card). */}
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
            {task.title}
          </Text>
          {showTicketNumbers ? (
            <MonoText size="caption" color="muted" testID={`${testID}-display-id`}>
              #{task.display_id}
            </MonoText>
          ) : null}
          {/* The testID goes on a wrapping View, not the lucide glyph: lucide
              forwards `testID` as the web-only `data-testid` prop, which is
              inert in React Native, so neither RNTL nor Maestro can select it.
              AgentStatusIcon needs no wrapper - it draws react-native-svg,
              which forwards testID properly.

              The same wrapper carries the accessibility label, because the
              glyph alone cannot say which state it is in and the merge verdict
              has a freshness caveat that has nowhere else to live on a touch
              surface (no hover, so no tooltip). */}
          {hasPr ? (
            <View
              testID={`${testID}-pr`}
              accessible
              accessibilityRole="text"
              accessibilityLabel={prChipAccessibilityLabel(task.pr_state, task.pr_merge_readiness)}
            >
              {prGlyph(prChip.glyph, colorForTextRole(prChip.color, theme.colors))}
            </View>
          ) : null}
        </Row>
        {bodyText.length > 0 || bodyMinHeight !== undefined ? (
          bodyMinHeight !== undefined ? (
            // Fixed slot: the box owns the height and the text is centered
            // inside it, so one-line and two-line snippets occupy exactly
            // the same space and neighbouring cards never shift. It has the
            // full width: the wait time that used to end this line moved up
            // into the band.
            <View style={{ height: bodyMinHeight, justifyContent: 'center' }}>
              <Text variant="caption" color="muted" numberOfLines={bodyNumberOfLines} testID={`${testID}-snippet`}>
                {bodyText}
              </Text>
            </View>
          ) : (
            <Text variant="caption" color="muted" numberOfLines={bodyNumberOfLines} testID={`${testID}-snippet`}>
              {bodyText}
            </Text>
          )
        ) : null}
        {hasMetaRow ? (
          <Row
            gap="sm"
            style={styles.metaRow}
            onLayout={(event: LayoutChangeEvent) => setLabelsRowWidth(event.nativeEvent.layout.width)}
          >
            {visibleLabels.map((label) => (
              <Badge key={label} label={label} color="secondary" />
            ))}
            {hiddenLabelCount > 0 ? <Badge label={`+${hiddenLabelCount}`} color="secondary" /> : null}
          </Row>
        ) : null}
        {footer !== null ? (
          <View
            style={[styles.utilityStrip, { borderTopColor: theme.colors.border, marginTop: theme.spacing.xs, paddingTop: theme.spacing.sm }]}
          >
            {footer}
          </View>
        ) : null}
      </Stack>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  spaceBetween: {
    justifyContent: 'space-between',
  },
  metaRow: {
    alignItems: 'center',
  },
  utilityStrip: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
