import React from 'react';
import { StyleSheet, View } from 'react-native';
import { CirclePause, LoaderCircle } from 'lucide-react-native';
import type { SessionUsageWire } from '@kangentic/protocol';
import { ContextUsageBar, Row, StatusSpinner, Text, useTheme } from '@/components';
import type { WorkflowWaitingFooter } from '@/workflow/workflowWaiting';
import type { CardSessionDisplay } from './cardSessionDisplay';

/** The desktop footer's glyph size (lucide Loader2 / CirclePause at 12). */
const STATUS_GLYPH_SIZE = 12;
/** The desktop's wording, verbatim (TaskCard.tsx's bottom-bar switch). */
const STARTING_AGENT_LABEL = 'Starting agent...';
const RESUMING_AGENT_LABEL = 'Resuming agent...';
const QUEUED_LABEL = 'Queued...';
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
  /** The card's testID: the usage bar keys off it as `-usage`, a status bar as `-status-bar`. */
  testID: string;
}

/**
 * The task card's footer, a port of the desktop card's bottom-bar switch
 * (kangentic `src/renderer/components/board/TaskCard.tsx`): every state a
 * session can be in between "nothing" and "working" shows here, as faint text
 * beside a 12 dp glyph over an empty track, and nowhere else on the card.
 *
 *   - running, model not reported yet: spinner, "Starting agent...", or
 *     "Resuming agent..." for a session the desktop spawned as a resume
 *   - running: the usage bar (model, %, fill), at 0% until the window is known
 *   - preparing (a respawn's step): spinner, the desktop's own step text
 *   - queued: spinner, "Queued..."
 *   - suspended: a still pause circle, "Paused"
 *   - none, exited: a workflow task's wait when it waits in To Do (a STILL
 *     spinner shape, since a task waiting on another is not loading, or the
 *     pause circle), else nothing
 *
 * Every bar keeps the usage bar's box (a caption row over a 4 dp track), so a
 * card holds one height from queued through running. Returns null when there
 * is no footer, so the card can drop its divider with it.
 *
 * A plain function, not a component: the card needs to know whether a footer
 * exists before it draws the divider above it. It calls no hooks; the bars it
 * returns are components that do.
 */
export function cardStatusFooter({ display, usage, waiting = null, testID }: CardStatusFooterProps): React.JSX.Element | null {
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
    case 'queued':
      return <StatusBar glyph="spinner" label={QUEUED_LABEL} testID={`${testID}-status-bar`} />;
    case 'suspended':
      return <StatusBar glyph="pause" label={PAUSED_LABEL} testID={`${testID}-status-bar`} />;
    case 'none':
    case 'exited':
      if (waiting === null) return null;
      return <StatusBar glyph={waiting.paused ? 'pause' : 'still'} label={waiting.label} testID={`${testID}-status-bar`} />;
  }
}

/** The desktop's `CardStatusBar`: a faint label row over an inert, empty track. */
function StatusBar({ glyph, label, testID }: { glyph: 'spinner' | 'still' | 'pause'; label: string; testID: string }): React.JSX.Element {
  const theme = useTheme();
  const glyphColor = theme.colors.textMuted;
  return (
    <View testID={testID}>
      <Row gap="xs" style={styles.labelRow}>
        {glyph === 'spinner' ? (
          // Keyed on the label so each new step ("Queued..." then "Starting
          // agent...", or a respawn's next step) gets its own spin window rather
          // than inheriting one a long queue already used up.
          <StatusSpinner key={label} size={STATUS_GLYPH_SIZE} color={glyphColor} testID={`${testID}-spinner`} />
        ) : glyph === 'still' ? (
          // The desktop's waiting footer: Loader2's shape at rest (task-card-view.tsx).
          <View testID={`${testID}-waiting`}>
            <LoaderCircle size={STATUS_GLYPH_SIZE} color={glyphColor} />
          </View>
        ) : (
          // The testID rides a wrapping View: lucide forwards `testID` as the
          // web-only `data-testid`, which neither RNTL nor Maestro can select.
          <View testID={`${testID}-paused`}>
            <CirclePause size={STATUS_GLYPH_SIZE} color={glyphColor} />
          </View>
        )}
        <Text variant="caption" color="muted" numberOfLines={1} style={styles.label} testID={`${testID}-label`}>
          {label}
        </Text>
      </Row>
      <View style={[styles.track, { backgroundColor: theme.colors.border, marginTop: theme.spacing.xs }]} />
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
  track: {
    height: 4,
    borderRadius: 2,
  },
});
