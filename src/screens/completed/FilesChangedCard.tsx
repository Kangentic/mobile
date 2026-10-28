import React from 'react';
import { StyleSheet, View } from 'react-native';
import { ArrowRight, Copy, FileQuestionMark, Minus, Pencil, Plus } from 'lucide-react-native';
import type { DiffFileStatusWire } from '@kangentic/protocol';
import { Button, MonoText, Text, useTheme, type Theme } from '@/components';
import { splitPathForDisplay } from '@/diff/pathDisplay';
import type { CompletedTaskFile } from '@/taskReport/completedTaskReport';
import { ReportCardTitle } from './ReportCard';

/**
 * The Files changed card, drawn as three kinds of list row so every file is
 * its own FlashList item (see `summaryItems`): the header carries the card's
 * top edge, each row its sides, and the footer its bottom edge and Show all.
 * Display only, for the same reason as Commits.
 */

const ROW_HEIGHT = 24;
const STATUS_ICON_SIZE = 12;

/** The desktop's file-status glyphs (`changes/file-status.ts`), colored with the phone's tokens. */
function statusIcon(status: DiffFileStatusWire, theme: Theme): React.JSX.Element {
  switch (status) {
    case 'A':
      return <Plus size={STATUS_ICON_SIZE} color={theme.colors.success} />;
    case 'M':
      return <Pencil size={STATUS_ICON_SIZE} color={theme.colors.warning} />;
    case 'D':
      return <Minus size={STATUS_ICON_SIZE} color={theme.colors.danger} />;
    case 'R':
      return <ArrowRight size={STATUS_ICON_SIZE} color={theme.colors.info} />;
    case 'C':
      return <Copy size={STATUS_ICON_SIZE} color={theme.colors.info} />;
    case 'U':
      return <FileQuestionMark size={STATUS_ICON_SIZE} color={theme.colors.success} />;
  }
}

const STATUS_WORDS: Readonly<Record<DiffFileStatusWire, string>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'untracked',
};

function cardSides(theme: Theme): { backgroundColor: string; borderColor: string; borderLeftWidth: number; borderRightWidth: number; paddingHorizontal: number } {
  return {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: theme.spacing.md,
  };
}

export function FilesChangedHeader({ fileCount }: { fileCount: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID="completed-summary-files"
      style={[
        cardSides(theme),
        {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopLeftRadius: theme.radii.md,
          borderTopRightRadius: theme.radii.md,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.sm,
        },
      ]}
    >
      <ReportCardTitle title="Files changed" aside={fileCount} testID="completed-summary-files" />
    </View>
  );
}

/**
 * One file: its status glyph, its path (the folder muted, the file name
 * brighter, cut from the front so the name stays visible) and its +/- counts.
 * A file from the `find_task` fallback has a path and nothing else.
 */
export function FileChangedRow({ file, index }: { file: CompletedTaskFile; index: number }): React.JSX.Element {
  const theme = useTheme();
  const { directory, basename } = splitPathForDisplay(file.path);
  const statusWord = file.status !== undefined ? `${STATUS_WORDS[file.status]}, ` : '';
  const counts =
    file.binary === true
      ? ', binary'
      : file.insertions !== undefined && file.deletions !== undefined
        ? `, ${file.insertions} added, ${file.deletions} removed`
        : '';
  return (
    <View
      testID={`completed-summary-file-${index}`}
      accessible
      accessibilityLabel={`${statusWord}${file.path}${counts}`}
      style={[cardSides(theme), styles.row, { gap: theme.spacing.sm }]}
    >
      {file.status !== undefined ? <View style={styles.statusIcon}>{statusIcon(file.status, theme)}</View> : null}
      <MonoText size="caption" color="secondary" numberOfLines={1} ellipsizeMode="head" style={styles.path}>
        {directory.length > 0 ? (
          <MonoText size="caption" color="muted">
            {directory}
          </MonoText>
        ) : null}
        {basename}
      </MonoText>
      {file.binary === true ? (
        <Text variant="caption" color="muted">
          binary
        </Text>
      ) : file.insertions !== undefined && file.deletions !== undefined ? (
        <View style={[styles.counts, { gap: theme.spacing.xs }]}>
          <MonoText size="caption" style={{ color: theme.colors.diffAddText }}>{`+${file.insertions}`}</MonoText>
          <MonoText size="caption" style={{ color: theme.colors.diffRemoveText }}>{`-${file.deletions}`}</MonoText>
        </View>
      ) : null}
    </View>
  );
}

/** The card's bottom edge, with "Show all N" while rows are held back. It expands in place; like the desktop's box, it does not collapse again. */
export function FilesChangedFooter({ hiddenCount, filesSent, onShowAll }: { hiddenCount: number; filesSent: number; onShowAll: () => void }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        cardSides(theme),
        {
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomLeftRadius: theme.radii.md,
          borderBottomRightRadius: theme.radii.md,
          paddingTop: hiddenCount > 0 ? theme.spacing.sm : 0,
          paddingBottom: theme.spacing.md,
        },
      ]}
    >
      {hiddenCount > 0 ? (
        <Button variant="ghost" label={`Show all ${filesSent}`} onPress={onShowAll} testID="completed-summary-files-show-all" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    height: ROW_HEIGHT,
  },
  statusIcon: {
    alignItems: 'center',
    width: STATUS_ICON_SIZE + 2,
  },
  path: {
    flex: 1,
    minWidth: 0,
  },
  counts: {
    flexDirection: 'row',
  },
});
