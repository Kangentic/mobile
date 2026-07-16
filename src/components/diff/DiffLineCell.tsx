import React from 'react';
import { StyleSheet, View } from 'react-native';
import { MonoText, useTheme } from '@/components';
import type { DiffLine } from '@/diff/diffLines';

export interface DiffLineCellProps {
  line: DiffLine;
}

const LINE_NUMBER_COLUMN_WIDTH_PX = 34;

/**
 * One row of the unified diff: a fixed-width old/new line-number gutter and
 * the line text, mono caption (12px dense floor), never wrapping - the parent
 * horizontal ScrollView owns overflow.
 */
export function DiffLineCell({ line }: DiffLineCellProps): React.JSX.Element {
  const theme = useTheme();

  let backgroundColor = 'transparent';
  let textColor = theme.colors.textPrimary;
  if (line.kind === 'add') {
    backgroundColor = theme.colors.diffAddBackground;
    textColor = theme.colors.diffAddText;
  } else if (line.kind === 'remove') {
    backgroundColor = theme.colors.diffRemoveBackground;
    textColor = theme.colors.diffRemoveText;
  } else if (line.kind === 'hunk-header') {
    backgroundColor = theme.colors.codeBackground;
    textColor = theme.colors.textMuted;
  }

  return (
    <View style={[styles.row, { backgroundColor }]}>
      <MonoText size="caption" color="muted" numberOfLines={1} style={styles.lineNumber}>
        {line.oldLineNumber === null ? '' : String(line.oldLineNumber)}
      </MonoText>
      <MonoText size="caption" color="muted" numberOfLines={1} style={styles.lineNumber}>
        {line.newLineNumber === null ? '' : String(line.newLineNumber)}
      </MonoText>
      <MonoText size="caption" numberOfLines={1} style={[styles.lineText, { color: textColor }]}>
        {line.text}
      </MonoText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  lineNumber: {
    width: LINE_NUMBER_COLUMN_WIDTH_PX,
    textAlign: 'right',
    paddingRight: 4,
  },
  lineText: {
    flexShrink: 0,
  },
});
