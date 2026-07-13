import React from 'react';
import { ScrollView, View } from 'react-native';
import { MonoText, useTheme } from '@/components';
import type { DiffLine } from '@/diff/diffLines';

export interface InlineDiffProps {
  lines: DiffLine[];
  testID?: string;
}

/**
 * Compact old/new diff rendering for tool-call and permission cards: mono
 * caption lines tinted with the diff tokens, hunk headers dimmed, no line
 * gutter. Long lines scroll horizontally (each line stays on one row) so the
 * diff shape survives phone width.
 */
export function InlineDiff({ lines, testID }: InlineDiffProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID={testID}>
      <View>
        {lines.map((line, lineIndex) => {
          if (line.kind === 'hunk-header') {
            return (
              <MonoText key={lineIndex} size="caption" color="muted" numberOfLines={1}>
                {line.text}
              </MonoText>
            );
          }
          const backgroundColor =
            line.kind === 'add'
              ? theme.colors.diffAddBackground
              : line.kind === 'remove'
                ? theme.colors.diffRemoveBackground
                : undefined;
          const textColor =
            line.kind === 'add'
              ? theme.colors.diffAddText
              : line.kind === 'remove'
                ? theme.colors.diffRemoveText
                : theme.colors.textSecondary;
          const linePrefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
          return (
            <MonoText
              key={lineIndex}
              size="caption"
              numberOfLines={1}
              style={{ backgroundColor, color: textColor, paddingHorizontal: theme.spacing.xs }}
            >
              {`${linePrefix}${line.text}`}
            </MonoText>
          );
        })}
      </View>
    </ScrollView>
  );
}
