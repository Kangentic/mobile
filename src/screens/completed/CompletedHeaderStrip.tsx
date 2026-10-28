import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import { CircleCheck, CircleX } from 'lucide-react-native';
import { PressScale, Text, colorForTextRole, useTheme } from '@/components';
import { prChipPresentation } from '@/components/board/prChipPresentation';
import { prGlyph } from '@/components/board/prGlyph';
import type { HeaderStripModel, StripCell, StripPullRequest } from '@/taskReport/headerStrip';
import { FigureRow, type FigureCellSpec } from './FigureRow';

/** The approved drawing's row padding: 10 pt above and below each row of figures. */
const STRIP_ROW_PADDING = 10;
/** The foot row holds the PR chip, so it is at least a touch target tall. */
const STRIP_FOOT_MIN_HEIGHT = 52;
const PR_CHIP_HEIGHT = 36;
const PR_GLYPH_SIZE = 16;
const STATUS_ICON_SIZE = 16;
/** Grows the 36 pt chip's touch area to the 44 pt floor without growing what is drawn. */
const PR_CHIP_HIT_SLOP = { top: 4, bottom: 4, left: 0, right: 0 };

function figureCellSpec(cell: StripCell, addColor: string, removeColor: string): FigureCellSpec {
  if (cell.kind === 'changes') {
    return {
      key: cell.key,
      label: cell.label,
      accessibilityLabel: cell.accessibilityLabel,
      value: (
        <>
          <Text variant="bodyStrong" style={{ color: addColor }}>
            {cell.added}
          </Text>{' '}
          <Text variant="bodyStrong" style={{ color: removeColor }}>
            {cell.removed}
          </Text>
        </>
      ),
    };
  }
  return { key: cell.key, label: cell.label, value: cell.value, accessibilityLabel: cell.accessibilityLabel };
}

/**
 * The completed task's header strip, after the desktop's `CompletedHeaderStrip`:
 * Started and Ended, then Elapsed, Agent runtime, Changes and Cost, then the
 * pull request and the status. An edge-to-edge band at the top of Summary,
 * which it scrolls with; the desktop's sits above its tabs, but on a phone the
 * Conversation segment needs that height.
 */
export function CompletedHeaderStrip({
  strip,
  prState,
  prMergeReadiness,
}: {
  strip: HeaderStripModel;
  prState: string | null;
  prMergeReadiness: string | null | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const addColor = theme.colors.diffAddText;
  const removeColor = theme.colors.diffRemoveText;
  const rows = [strip.spanCells, strip.figureCells].filter((cells) => cells.length > 0);

  return (
    <View
      testID="completed-strip"
      style={[styles.band, { borderBottomColor: theme.colors.border, paddingHorizontal: theme.spacing.md }]}
    >
      {rows.map((cells, rowIndex) => (
        <View
          key={cells[0].key}
          style={[
            { paddingVertical: STRIP_ROW_PADDING },
            rowIndex > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border } : null,
          ]}
        >
          <FigureRow
            testID={rowIndex === 0 && strip.spanCells.length > 0 ? 'completed-strip-span' : 'completed-strip-figures'}
            cells={cells.map((cell) => figureCellSpec(cell, addColor, removeColor))}
          />
        </View>
      ))}
      <View
        style={[
          styles.foot,
          rows.length > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border } : null,
        ]}
      >
        {strip.pullRequest !== null ? (
          <PullRequestChip pullRequest={strip.pullRequest} prState={prState} prMergeReadiness={prMergeReadiness} />
        ) : (
          <View />
        )}
        <View testID="completed-strip-status" style={[styles.status, { gap: theme.spacing.xs }]}>
          {strip.status.kind === 'exited' ? (
            <CircleX size={STATUS_ICON_SIZE} color={theme.colors.danger} />
          ) : (
            <CircleCheck size={STATUS_ICON_SIZE} color={theme.colors.success} />
          )}
          <Text color={strip.status.kind === 'exited' ? 'danger' : 'success'}>{strip.status.label}</Text>
        </View>
      </View>
    </View>
  );
}

/**
 * The PR as the board card draws it (same glyph and color), with its number
 * and state word. It opens the PR in the OS handler, https only; there is no
 * error surface in the strip, so a refusal does nothing, as a markdown link's
 * does. Without an https URL it is shown but not pressable.
 */
function PullRequestChip({
  pullRequest,
  prState,
  prMergeReadiness,
}: {
  pullRequest: StripPullRequest;
  prState: string | null;
  prMergeReadiness: string | null | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const presentation = prChipPresentation(prState, prMergeReadiness);
  const url = pullRequest.url;
  const onPress = useCallback(() => {
    if (url === null) return;
    void Linking.openURL(url).catch((error: unknown) => {
      if (__DEV__) console.warn('[completed-task] could not open the pull request:', error);
    });
  }, [url]);

  const content = (
    <>
      {prGlyph(presentation.glyph, colorForTextRole(presentation.color, theme.colors), PR_GLYPH_SIZE)}
      <Text variant="bodyStrong">{`#${pullRequest.number}`}</Text>
      {pullRequest.stateWord !== null ? <Text color="secondary">{pullRequest.stateWord}</Text> : null}
    </>
  );
  const chipStyle = [
    styles.chip,
    {
      backgroundColor: theme.colors.surfaceRaised,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.md,
      gap: theme.spacing.xs,
      paddingHorizontal: theme.spacing.md,
    },
  ];

  if (url === null) {
    return (
      <View testID="completed-strip-pr" accessible accessibilityLabel={pullRequest.accessibilityLabel} style={chipStyle}>
        {content}
      </View>
    );
  }
  return (
    <PressScale
      testID="completed-strip-pr"
      accessibilityRole="link"
      accessibilityLabel={pullRequest.accessibilityLabel}
      hitSlop={PR_CHIP_HIT_SLOP}
      onPress={onPress}
      style={chipStyle}
    >
      {content}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  band: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  foot: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: STRIP_FOOT_MIN_HEIGHT,
  },
  chip: {
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    height: PR_CHIP_HEIGHT,
  },
  status: {
    alignItems: 'center',
    flexDirection: 'row',
  },
});
