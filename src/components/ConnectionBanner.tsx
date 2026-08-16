import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useRouter } from 'expo-router';
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
 * How long a paired phone may sit with the relay socket up but no KK
 * session before "Connecting..." stops being true. Past this the desktop
 * is either off or has removed this device - the phone cannot tell which -
 * so the pill escalates to honest copy and a route to the devices screen,
 * where unpairing is local and needs no channel. Matches
 * ConnectingEmptyState's OFFER_RECOVERY_AFTER_MS.
 */
const ESCALATE_AFTER_MS = 20_000;

const ESCALATED_MESSAGE = "Can't reach desktop - tap to manage device";
// Accessibility labels stay fully descriptive (see ui-copy-brevity.md).
const ESCALATED_ACCESSIBILITY_LABEL =
  "Can't reach your desktop. Opens the devices screen, where you can manage or unpair this phone.";

/**
 * Floating channel-status pill. Hidden while the secure channel is fully
 * up (transport connected and the KK session established); after the grace
 * window it hangs just below the host's header from a zero-height anchor,
 * floating OVER the content - it never pushes the layout below it. Warning
 * tint while (re)connecting or connected-but-still-handshaking, danger
 * tint when genuinely offline.
 *
 * A paired phone whose transport stays connected with no session past
 * ESCALATE_AFTER_MS gets the tappable can't-reach pill instead, routing to
 * the devices screen. The offline pill never escalates: a dead transport
 * means the RELAY is unreachable - a network problem the devices screen
 * cannot fix, and no reason to signpost unpairing.
 */
export function ConnectionBanner(): React.JSX.Element | null {
  const theme = useTheme();
  const motionPresets = useMotionPresets();
  const router = useRouter();
  const transportState = useChannelStore((state) => state.transportState);
  const established = useChannelStore((state) => state.established);
  const everEstablished = useChannelStore((state) => state.everEstablished);
  const pairedState = useChannelStore((state) => state.pairedState);

  const healthy = transportState === 'connected' && established;
  // The relay answers but the desktop never completes a handshake while a
  // trust anchor exists: the desktop is off, asleep, or revoked this phone.
  const desktopSilent =
    pairedState === 'paired' && transportState === 'connected' && !established;

  const [showDegraded, setShowDegraded] = useState(false);
  // Adjust-during-render: recovery hides the banner in the same pass.
  if (healthy && showDegraded) setShowDegraded(false);
  useEffect(() => {
    if (healthy) return;
    const graceTimer = setTimeout(() => setShowDegraded(true), DEGRADED_GRACE_MS);
    return () => clearTimeout(graceTimer);
  }, [healthy]);

  const [escalated, setEscalated] = useState(false);
  // Any break in the silent window resets the sustained count.
  if (!desktopSilent && escalated) setEscalated(false);
  useEffect(() => {
    if (!desktopSilent) return;
    const escalateTimer = setTimeout(() => setEscalated(true), ESCALATE_AFTER_MS);
    return () => clearTimeout(escalateTimer);
  }, [desktopSilent]);

  if (pairedState === 'unpaired') {
    return null;
  }

  // The escalated pill deliberately skips the everEstablished gate below:
  // after a revocation, or with the desktop long off, a cold start never
  // establishes at all, and the sustained silence IS the signal.
  if (escalated) {
    return (
      <View style={styles.overlayAnchor} pointerEvents="box-none">
        <Animated.View
          entering={motionPresets.bannerIn}
          exiting={motionPresets.bannerOut}
          style={[
            styles.escalatedPill,
            { left: theme.spacing.md, right: theme.spacing.md, top: theme.spacing.sm },
          ]}
        >
          <Pressable
            testID="connection-banner-escalated"
            accessibilityRole="button"
            accessibilityLabel={ESCALATED_ACCESSIBILITY_LABEL}
            hitSlop={{ bottom: 10, top: 10 }}
            onPress={() => router.push('/devices')}
            style={({ pressed }) => [
              styles.escalatedSurface,
              {
                backgroundColor: theme.colors.danger,
                borderRadius: theme.radii.sm,
                opacity: pressed ? 0.7 : 1,
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.xs,
              },
            ]}
          >
            <Text variant="caption" style={{ color: theme.colors.onAccent }}>
              {ESCALATED_MESSAGE}
            </Text>
          </Pressable>
        </Animated.View>
      </View>
    );
  }

  // The banner warns about a REGRESSION of a working link. Startup - the
  // first connect of the launch, which can honestly take a few seconds -
  // is narrated by the screens' connecting states instead, so the pill
  // never flickers in during a normal cold start or foreground return.
  if (!everEstablished || healthy || !showDegraded) {
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
            left: theme.spacing.md,
            paddingHorizontal: theme.spacing.md,
            paddingVertical: theme.spacing.xs,
            right: theme.spacing.md,
            top: theme.spacing.sm,
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
  // The escalated wrapper stretches full width so the Pressable is the
  // whole pill surface; the surface centers the label itself.
  escalatedPill: {
    position: 'absolute',
  },
  escalatedSurface: {
    alignItems: 'center',
  },
  // A zero-height in-flow anchor: every host renders the banner immediately
  // after its header, so the absolutely positioned pill hangs just below the
  // header, floating OVER the content without occupying layout - its
  // arrival shifts nothing.
  overlayAnchor: {
    height: 0,
    overflow: 'visible',
    zIndex: 10,
  },
  pill: {
    alignItems: 'center',
    position: 'absolute',
  },
});
