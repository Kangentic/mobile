import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useChannelStore } from '@/state/channelStore';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';

/**
 * Slim full-width channel-status bar. Hidden while the secure channel is fully
 * up (transport connected and the KK session established); shows a warning
 * tint while the transport is (re)connecting OR connected-but-still-handshaking
 * (the desktop re-initiates the Noise KK handshake on reconnect, a brief window
 * where the socket is up but the session is not yet established), and a danger
 * tint only when genuinely offline. Subscribes to the channel store reactively,
 * so it updates in place.
 */
export function ConnectionBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const transportState = useChannelStore((state) => state.transportState);
  const established = useChannelStore((state) => state.established);

  if (transportState === 'connected' && established) {
    return null;
  }

  // A connected transport that has not established yet is mid-handshake, not
  // offline: treat it as connecting so the reconnect window reads as recovery.
  const isConnecting =
    transportState === 'connecting' ||
    transportState === 'reconnecting' ||
    (transportState === 'connected' && !established);
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
