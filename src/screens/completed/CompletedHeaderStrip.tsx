import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { CircleCheck, CircleX, ExternalLink, Link2, Shapes } from 'lucide-react-native';
import { PressScale, Text, colorForTextRole, useTheme } from '@/components';
import { prChipPresentation } from '@/components/board/prChipPresentation';
import { prGlyph } from '@/components/board/prGlyph';
import { artifactCountLabel, type TaskArtifactLink } from '@/lib/taskArtifacts';
import type { HeaderStripModel, StripCell, StripPullRequest } from '@/taskReport/headerStrip';
import { openArtifactLink } from '../artifacts/taskArtifactLinks';
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
const ARTIFACT_GLYPH_SIZE = 16;
const ARTIFACT_TRAILING_GLYPH_SIZE = 12;
const NO_ARTIFACT_LINKS: readonly TaskArtifactLink[] = [];

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
  taskId = null,
  artifactLinks = NO_ARTIFACT_LINKS,
}: {
  strip: HeaderStripModel;
  prState: string | null;
  prMergeReadiness: string | null | undefined;
  /** The task, for the Artifacts sheet a chip with several links opens. */
  taskId?: string | null;
  /** The task's openable links (protocol 0.28.0, `openableArtifacts`): a chip beside the PR chip when there are any. */
  artifactLinks?: readonly TaskArtifactLink[];
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
        <View style={[styles.chips, { gap: theme.spacing.sm }]}>
          {strip.pullRequest !== null ? (
            <PullRequestChip pullRequest={strip.pullRequest} prState={prState} prMergeReadiness={prMergeReadiness} />
          ) : null}
          {artifactLinks.length > 0 ? <ArtifactsChip links={artifactLinks} taskId={taskId} /> : null}
        </View>
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

/**
 * The task's links (protocol 0.28.0), as the desktop's completed strip carries
 * them beside its PR: one link is a chip naming it, which opens it in the OS
 * handler; several are "N artifacts", which opens the Artifacts sheet. The
 * same chip as the PR's, so the two read as a pair. There is no error surface
 * in the strip, so a link the OS refuses does nothing, as the PR chip's does.
 */
function ArtifactsChip({ links, taskId }: { links: readonly TaskArtifactLink[]; taskId: string | null }): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const single = links.length === 1 ? links[0] : null;
  const onPress = useCallback(() => {
    if (single !== null) {
      void openArtifactLink(single).catch((error: unknown) => {
        if (__DEV__) console.warn('[completed-task] could not open the link:', error);
      });
      return;
    }
    if (taskId !== null) router.push({ pathname: '/task-artifacts', params: { taskId } });
  }, [single, taskId, router]);
  return (
    <PressScale
      testID="completed-strip-artifacts"
      accessibilityRole={single !== null ? 'link' : 'button'}
      accessibilityLabel={single !== null ? `Open ${single.name}` : `${artifactCountLabel(links.length)}, open the list`}
      hitSlop={PR_CHIP_HIT_SLOP}
      onPress={onPress}
      style={[
        styles.chip,
        styles.artifactsChip,
        {
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          gap: theme.spacing.xs,
          paddingHorizontal: theme.spacing.md,
        },
      ]}
    >
      {single !== null ? (
        <>
          <Link2 size={ARTIFACT_GLYPH_SIZE} color={theme.colors.textSecondary} />
          <Text color="secondary" numberOfLines={1} style={styles.artifactName}>
            {single.name}
          </Text>
          <ExternalLink size={ARTIFACT_TRAILING_GLYPH_SIZE} color={theme.colors.textMuted} />
        </>
      ) : (
        <>
          <Shapes size={ARTIFACT_GLYPH_SIZE} color={theme.colors.textSecondary} />
          <Text color="secondary" numberOfLines={1}>
            {artifactCountLabel(links.length)}
          </Text>
        </>
      )}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  band: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chips: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    minWidth: 0,
  },
  artifactsChip: {
    flexShrink: 1,
    minWidth: 0,
  },
  artifactName: {
    flexShrink: 1,
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
