import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '../Text';
import { useTheme } from '../theme/ThemeProvider';

/**
 * The "Command Terminal" pill (decision G1): marks a terminal so it never reads
 * as a board task. Always on an Agents feed card, in the band's top right where
 * a task draws its column track; in an open terminal's header once the
 * terminal has a name of its own (before that its title already says
 * "Command Terminal N"). A label, not a control: no press, no touch target.
 */
export function CommandTerminalPill({ testID }: { testID?: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.pill,
        {
          borderRadius: theme.radii.full,
          paddingHorizontal: theme.spacing.sm,
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Text variant="caption" color="secondary" numberOfLines={1}>
        Command Terminal
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexShrink: 0,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
});
