import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useChannelStore } from '@/state/channelStore';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';
import { useMotionPresets } from './motion/presets';

/**
 * How long the channel must stay degraded before the banner appears.
 * Routine dips (a foreground reconnect, a relay blip, the mid-handshake
 * window after the socket comes up) resolve well inside this, so the
 * banner only surfaces outages the user can actually feel. Recovery
 * hides it immediately.
 */
const DEGRADED_GRACE_MS = 2000;

/**
 * Floating channel-status pill. Hidden while the secure channel is fully
 * up (transport connected and the KK session established); after the grace
 * window it floats OVER the content from a zero-height anchor - it never
 * pushes the layout below it. Warning tint while (re)connecting or
 * connected-but-still-handshaking, danger tint only when genuinely offline.
 */
export function ConnectionBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const motionPresets = useMotionPresets();
  const transportState = useChannelStore((state) => state.transportState);
  const established = useChannelStore((state) => state.established);

  const healthy = transportState === 'connected' && established;

  const [showDegraded, setShowDegraded] = useState(false);
  // Adjust-during-render: recovery hides the banner in the same pass.
  if (healthy && showDegraded) setShowDegraded(false);
  useEffect(() => {
    if (healthy) return;
    const graceTimer = setTimeout(() => setShowDegraded(true), DEGRADED_GRACE_MS);
    return () => clearTimeout(graceTimer);
  }, [healthy]);

  if (healthy || !showDegraded) {
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
    <View style={styles.overlayAnchor} pointerEvents="box-none">
      <Animated.View
        testID="connection-banner"
        entering={motionPresets.bannerIn}
        exiting={motionPresets.bannerOut}
        style={[
          styles.pill,
          {
            backgroundColor,
            borderRadius: theme.radii.sm,
            top: theme.spacing.xs,
            left: theme.spacing.md,
            right: theme.spacing.md,
            paddingVertical: theme.spacing.xs,
            paddingHorizontal: theme.spacing.md,
          },
        ]}
      >
        <Text variant="caption" style={{ color: theme.colors.onAccent }}>
          {message}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Zero-height: the pill overlays the content below instead of occupying
  // layout, so its arrival never shifts the feed. The pill is absolutely
  // positioned so the anchor's zero height cannot squash its measure.
  overlayAnchor: {
    height: 0,
    overflow: 'visible',
    width: '100%',
    zIndex: 10,
  },
  pill: {
    alignItems: 'center',
    position: 'absolute',
  },
});
