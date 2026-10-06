import React from 'react';
import { StyleSheet, View } from 'react-native';
import { CirclePause } from 'lucide-react-native';
import type { SessionUsageWire } from '@kangentic/protocol';
import { ContextUsageBar, Row, StatusSpinner, Text, useTheme } from '@/components';
import type { CardSessionDisplay } from './cardSessionDisplay';

/** The desktop footer's glyph size (lucide Loader2 / CirclePause at 12). */
const STATUS_GLYPH_SIZE = 12;
/** The desktop's wording, verbatim (TaskCard.tsx's bottom-bar switch). */
const STARTING_AGENT_LABEL = 'Starting agent...';
const QUEUED_LABEL = 'Queued...';
const PAUSED_LABEL = 'Paused';

export interface CardStatusFooterProps {
  display: CardSessionDisplay;
  usage: SessionUsageWire | null;
  /** The card's testID: the usage bar keys off it as `-usage`, a status bar as `-status-bar`. */
  testID: string;
}

/**
 * The task card's footer, a port of the desktop card's bottom-bar switch
 * (kangentic `src/renderer/components/board/TaskCard.tsx`): every state a
 * session can be in between "nothing" and "working" shows here, as faint text
 * beside a 12 dp glyph over an empty track, and nowhere else on the card.
 *
 *   - running, model not reported yet: spinner, "Starting agent..."
 *   - running: the usage bar (model, %, fill), at 0% until the window is known
 *   - preparing (a respawn's step): spinner, the desktop's own step text
 *   - queued: spinner, "Queued..."
 *   - suspended: a still pause circle, "Paused"
 *   - none, exited: nothing
 *
 * Every bar keeps the usage bar's box (a caption row over a 4 dp track), so a
 * card holds one height from queued through running. Returns null when there
 * is no footer, so the card can drop its divider with it.
 *
 * A plain function, not a component: the card needs to know whether a footer
 * exists before it draws the divider above it. It calls no hooks; the bars it
 * returns are components that do.
 */
export function cardStatusFooter({ display, usage, testID }: CardStatusFooterProps): React.JSX.Element | null {
  switch (display.kind) {
    case 'running': {
      // The desktop shows the human model name or nothing: never a raw id.
      const modelName = usage?.model.displayName ?? '';
      if (usage === null || modelName.length === 0) {
        return <StatusBar glyph="spinner" label={STARTING_AGENT_LABEL} testID={`${testID}-status-bar`} />;
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
      return null;
  }
}

/** The desktop's `CardStatusBar`: a faint label row over an inert, empty track. */
function StatusBar({ glyph, label, testID }: { glyph: 'spinner' | 'pause'; label: string; testID: string }): React.JSX.Element {
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
