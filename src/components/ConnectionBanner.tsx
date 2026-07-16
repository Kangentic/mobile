import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useChannelStore } from '@/state/channelStore';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';

/**
 * Slim full-width channel-status bar. Hidden while the secure channel is fully
 * up (transport connected and the KK session established); shows a warning
 * tint while the transport is (re)connecting and a danger tint otherwise.
 * Subscribes to the channel store reactively, so it updates in place.
 */
export function ConnectionBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const transportState = useChannelStore((state) => state.transportState);
  const established = useChannelStore((state) => state.established);

  if (transportState === 'connected' && established) {
    return null;
  }

  const isConnecting = transportState === 'connecting' || transportState === 'reconnecting';
  const backgroundColor = isConnecting ? theme.colors.warning : theme.colors.danger;
  const message = isConnecting ? 'Connecting to desktop...' : 'Offline - showing last known state';

  return (
    <View
      testID="connection-banner"
      style={[
        styles.bar,
        {
          backgroundColor,
          paddingVertical: theme.spacing.xs,
          paddingHorizontal: theme.spacing.md,
        },
      ]}
    >
      <Text variant="caption" style={{ color: theme.colors.background }}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: '100%',
    alignItems: 'center',
  },
});
