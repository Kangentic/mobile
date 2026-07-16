import React from 'react';
import { StyleSheet } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Stack } from '../Stack';
import { Text } from '../Text';
import { Overseer, type OverseerAnimation } from './Overseer';

export interface EmptyStateProps {
  title: string;
  caption?: string;
  /** Overseer width in dp; the closed placement list uses 90/72/54. */
  overseerSize?: number;
  overseerAnimate?: OverseerAnimation;
  /** CTA slot rendered under the caption (a Button, a link row, anything). */
  children?: React.ReactNode;
  testID?: string;
}

/**
 * The standard empty-state layout: the Overseer mascot over a title, an
 * optional caption, and an optional CTA slot, centered in whatever space the
 * parent gives it. Placements are a closed list (see the brand plan); new
 * surfaces adopt this component rather than composing their own mascot.
 */
export function EmptyState({
  title,
  caption,
  overseerSize = 90,
  overseerAnimate = 'blink-loop',
  children,
  testID = 'empty-state',
}: EmptyStateProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Stack gap="md" testID={testID} style={[styles.container, { padding: theme.spacing.xl }]}>
      <Overseer size={overseerSize} animate={overseerAnimate} testID={`${testID}-overseer`} />
      <Text variant="title">{title}</Text>
      {caption !== undefined ? (
        <Text variant="body" color="secondary" style={styles.centeredText}>
          {caption}
        </Text>
      ) : null}
      {children}
    </Stack>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredText: {
    textAlign: 'center',
  },
});
