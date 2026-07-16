import React from 'react';
import { View } from 'react-native';
import { MonoText, useTheme } from '@/components';

export interface LiveTailCellProps {
  lines: string[];
}

/**
 * The token-by-token live stream while the agent is thinking: a dim
 * '▌ live' caption prefix, then the cleaned PTY tail lines as wrapping mono
 * caption text on the terminal background. Re-renders as the throttled tail
 * snapshot updates.
 */
export function LiveTailCell({ lines }: LiveTailCellProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.colors.terminalBackground,
        borderRadius: theme.radii.sm,
        marginHorizontal: theme.spacing.md,
        marginVertical: theme.spacing.sm,
        padding: theme.spacing.sm,
        gap: theme.spacing.xs,
      }}
    >
      <MonoText size="caption" color="muted">
        {'▌ live'}
      </MonoText>
      {lines.map((line, lineIndex) => (
        <MonoText key={lineIndex} size="caption" color="secondary">
          {line}
        </MonoText>
      ))}
    </View>
  );
}
