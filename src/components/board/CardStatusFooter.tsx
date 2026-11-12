import React from 'react';
import { StyleSheet, View } from 'react-native';
import { CircleExclamationPoint, CirclePause, Clock, LoaderCircle } from 'lucide-react-native';
import type { BoardTaskQueuePlaceWire, SessionUsageWire } from '@kangentic/protocol';
import { ContextUsageBar, Row, StatusSpinner, Text, useTheme } from '@/components';
import { queuedCardLabel, queuedCardTip } from '@/lib/queuePlace';
import { startBlockedCopy, type StartBlockedCopy } from '@/lib/startBlocked';
import type { WorkflowWaitingFooter } from '@/workflow/workflowWaiting';
import type { CardSessionDisplay } from './cardSessionDisplay';

/** The desktop footer's glyph size (lucide Loader2 / CirclePause / Clock / CircleExclamationPoint at 12). */
const STATUS_GLYPH_SIZE = 12;
/** The desktop's wording, verbatim (TaskCard.tsx's bottom-bar switch). */
const STARTING_AGENT_LABEL = 'Starting agent...';
const RESUMING_AGENT_LABEL = 'Resuming agent...';
const PAUSED_LABEL = 'Paused';

export interface CardStatusFooterProps {
  display: CardSessionDisplay;
  usage: SessionUsageWire | null;
  /**
   * A workflow task's wait in To Do (`workflowWaitingFooter`): "Blocked by
   * #413...", "Queued...", "Paused". Drawn only where the session has nothing
   * to say (none or exited), as the desktop's card draws it.
   */
  waiting?: WorkflowWaitingFooter | null;
  /** The board row's `queue_place` (protocol 0.28.0): a queued session's place in line. */
  queuePlace?: BoardTaskQueuePlaceWire | null;
  /** The board row's `start_blocked_reason` (protocol 0.28.0): why its last start never reached an agent. */
  startBlockedReason?: string | null;
  /** The card's testID: the usage bar keys off it as `-usage`, a status bar as `-status-bar`. */
  testID: string;
}

/**
 * The task card's footer, a port of the desktop card's bottom-bar switch
 * (kangentic `src/renderer/components/board/task-card-view.tsx`,
 * `PendingFooter`, `StartBlockedFooter` and `WorkflowWaitingBar`): every state
 * a session can be in between "nothing" and "working" shows here, as faint
 * text beside a 12 dp glyph, and nowhere else on the card.
 *
 *   - running, model not reported yet: spinner, "Starting agent...", or
 *     "Resuming agent..." for a session the desktop spawned as a resume
 *   - running: the usage bar (model, %, fill), at 0% until the window is known
 *   - preparing (a respawn's step): spinner, the desktop's own step text
 *   - queued: a still clock and the place in line (protocol 0.28.0's
 *     `queue_place`): "Next in line...", "1 task ahead...", "N tasks
 *     ahead...", or "Queued..." when no place is known. The desktop's hover
 *     tip ("Waiting for a slot in Merge.") becomes the accessibility label.
 *   - suspended: a still pause circle, "Paused"; or, when the row says its
 *     last start never reached an agent (`start_blocked_reason`), the
 *     desktop's warning words in its warning tone ("Worktree missing",
 *     "Folder missing", "Didn't start"), with the reason as the label
 *   - exited: the same start-blocked words when the row carries a reason,
 *     else a workflow task's wait when it waits in To Do (a STILL spinner
 *     shape, since a task waiting on another is not loading, or the pause
 *     circle), else nothing
 *   - none: as exited. The desktop shows a start-blocked footer only on an
 *     exited card, but the phone often holds no entry for a session that has
 *     ended and reads that card as none, and the row carries a reason only
 *     while the task has a paused or ended session, so the reason decides.
 *
 * No status line draws a track under it, as the desktop's `CardStatusBar`
 * draws none since d0aff06d4 ("drop the empty context track when no agent
 * runs"): an empty groove says nothing. So a card grows by the usage bar's
 * track when its agent reports a model and the usage bar takes over (task
 * #141, decision A1). Returns null when there is no footer, so the card can
 * drop its divider with it.
 *
 * A plain function, not a component: the card needs to know whether a footer
 * exists before it draws the divider above it. It calls no hooks; the bars it
 * returns are components that do.
 */
export function cardStatusFooter({
  display,
  usage,
  waiting = null,
  queuePlace = null,
  startBlockedReason = null,
  testID,
}: CardStatusFooterProps): React.JSX.Element | null {
  switch (display.kind) {
    case 'running': {
      // The desktop shows the human model name or nothing: never a raw id.
      const modelName = usage?.model.displayName ?? '';
      if (usage === null || modelName.length === 0) {
        const label = display.resuming ? RESUMING_AGENT_LABEL : STARTING_AGENT_LABEL;
        return <StatusBar glyph="spinner" label={label} testID={`${testID}-status-bar`} />;
      }
      return <ContextUsageBar usage={usage} testID={`${testID}-usage`} />;
    }
    case 'preparing':
      return <StatusBar glyph="spinner" label={display.label} testID={`${testID}-status-bar`} />;
    case 'queued': {
      const label = queuedCardLabel(queuePlace);
      const tip = queuedCardTip(queuePlace);
      return (
        <StatusBar
          glyph="queued"
          label={label}
          accessibilityLabel={tip !== null ? `${label} ${tip}` : undefined}
          testID={`${testID}-status-bar`}
        />
      );
    }
    case 'suspended': {
      const blocked = startBlockedCopy(startBlockedReason);
      if (blocked !== null) return <StartBlockedBar copy={blocked} testID={`${testID}-status-bar`} />;
      return <StatusBar glyph="pause" label={PAUSED_LABEL} testID={`${testID}-status-bar`} />;
    }
    case 'none':
    case 'exited': {
      const blocked = startBlockedCopy(startBlockedReason);
      if (blocked !== null) return <StartBlockedBar copy={blocked} testID={`${testID}-status-bar`} />;
      if (waiting === null) return null;
      return <StatusBar glyph={waiting.paused ? 'pause' : 'still'} label={waiting.label} testID={`${testID}-status-bar`} />;
    }
  }
}

/**
 * The glyph beside a status line. Only `spinner` moves; the other three are
 * still lucide shapes, each in a wrapping View that carries the testID, because
 * lucide forwards `testID` as the web-only `data-testid`, which neither RNTL nor
 * Maestro can select.
 */
type StatusGlyph = 'spinner' | 'still' | 'pause' | 'queued';

/** The desktop's `CardStatusBar`: one faint label row, with no track under it. */
function StatusBar({
  glyph,
  label,
  accessibilityLabel,
  testID,
}: {
  glyph: StatusGlyph;
  label: string;
  /** Set where the desktop has a hover tip, which a touch screen reads out instead. */
  accessibilityLabel?: string;
  testID: string;
}): React.JSX.Element {
  const theme = useTheme();
  const glyphColor = theme.colors.textMuted;
  return (
    <View testID={testID} accessible={accessibilityLabel !== undefined} accessibilityLabel={accessibilityLabel}>
      <Row gap="xs" style={styles.labelRow}>
        {glyph === 'spinner' ? (
          // Keyed on the label so each new step (a respawn's "Creating
          // worktree..." then "Starting agent...") gets its own spin window
          // rather than inheriting one a long step already used up.
          <StatusSpinner key={label} size={STATUS_GLYPH_SIZE} color={glyphColor} testID={`${testID}-spinner`} />
        ) : glyph === 'queued' ? (
          // The desktop's queued footer: a still clock (QueuedFooter). A queue
          // can last minutes, and waiting is not loading.
          <View testID={`${testID}-queued`}>
            <Clock size={STATUS_GLYPH_SIZE} color={glyphColor} />
          </View>
        ) : glyph === 'still' ? (
          // The desktop's workflow waiting footer: Loader2's shape at rest (WorkflowWaitingBar).
          <View testID={`${testID}-waiting`}>
            <LoaderCircle size={STATUS_GLYPH_SIZE} color={glyphColor} />
          </View>
        ) : (
          <View testID={`${testID}-paused`}>
            <CirclePause size={STATUS_GLYPH_SIZE} color={glyphColor} />
          </View>
        )}
        <Text variant="caption" color="muted" numberOfLines={1} style={styles.label} testID={`${testID}-label`}>
          {label}
        </Text>
      </Row>
    </View>
  );
}

/**
 * The desktop's `StartBlockedFooter`: the same bar, glyph and label in its
 * warning tone (`text-warning`, the phone's caution yellow, which the desktop
 * also keeps apart from the attention amber). Its hover tip is the label a
 * screen reader hears.
 */
function StartBlockedBar({ copy, testID }: { copy: StartBlockedCopy; testID: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View testID={testID} accessible accessibilityLabel={`${copy.label}. ${copy.tip}`}>
      <Row gap="xs" style={styles.labelRow}>
        <View testID={`${testID}-start-blocked`}>
          <CircleExclamationPoint size={STATUS_GLYPH_SIZE} color={theme.colors.warning} />
        </View>
        <Text variant="caption" color="warning" numberOfLines={1} style={styles.label} testID={`${testID}-label`}>
          {copy.label}
        </Text>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: {
    alignItems: 'center',
  },
  label: {
    flexShrink: 1,
  },
});
