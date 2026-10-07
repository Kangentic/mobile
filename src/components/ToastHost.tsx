import React from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useToastStore, type Toast, type ToastVariant } from '@/state/toastStore';
import { mixHex } from './theme/color';
import { useTheme } from './theme/ThemeProvider';
import type { ColorTokens } from './theme/tokens';
import { useMotionPresets } from './motion/presets';
import { Text } from './Text';

/**
 * How far above the bottom inset the stack sits. Clears the tab bar (80 dp
 * on the Android emulator) and the session footer when it is the lens
 * switcher alone (about 92 dp), which is what a paused task's screen shows;
 * a footer with a composer is taller, and a toast there overlaps it for its
 * few seconds, which is why the card takes no touches (see the root below).
 * The desktop's stack likewise sits just above its status bar.
 */
const STACK_BOTTOM_CLEARANCE = 100;
/** The desktop card's `w-1` accent bar. */
const ACCENT_BAR_WIDTH = 4;
/** The desktop's dismiss glyph: lucide X at 14. */
const DISMISS_GLYPH_SIZE = 14;
const ELEVATION_SHADOW_OPACITY = 0.4;

/** The desktop's `variantStyles`, onto this app's semantic tokens. */
function variantColor(variant: ToastVariant, colors: ColorTokens): string {
  switch (variant) {
    case 'info':
      return colors.accent;
    case 'success':
      return colors.success;
    case 'warning':
      return colors.warning;
    case 'error':
      return colors.danger;
  }
}

/**
 * The app-wide toast stack (`useToastStore`), a port of the desktop's
 * ToastContainer: bottom right, newest last, content-width cards. Rendered
 * once, in the root layout, as a sibling AFTER the navigator so it draws
 * over every screen. Renders nothing while no toast is up.
 */
export function ToastHost(): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const toasts = useToastStore((state) => state.toasts);
  if (toasts.length === 0) return null;
  return (
    <View
      pointerEvents="box-none"
      accessibilityLiveRegion="polite"
      style={[
        styles.stack,
        { bottom: insets.bottom + STACK_BOTTOM_CLEARANCE, left: theme.spacing.md, right: theme.spacing.md, gap: theme.spacing.sm },
      ]}
      testID="toast-host"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </View>
  );
}

/**
 * One toast, the desktop's ToastItem: a surface card with the variant's
 * accent bar down its left edge and border at half strength, the message in
 * secondary text, and a faint dismiss X.
 *
 * The CARD takes no touches; only the X does. The desktop learned this the
 * hard way (its ToastItem comment): an interactive card sitting over live
 * controls swallowed their taps and did nothing itself. Here the stack sits
 * over the session footer's composer for a few seconds, so the same holds.
 *
 * Fades in with the banner preset and leaves with no exit animation: the
 * store's timer unmounts it, so a lost frame can never strand it on screen.
 */
function ToastCard({ toast }: { toast: Toast }): React.JSX.Element {
  const theme = useTheme();
  const motionPresets = useMotionPresets();
  const accent = variantColor(toast.variant, theme.colors);
  React.useEffect(() => {
    // Android reads the stack's live region; iOS has no live regions, so the
    // message is announced once, on arrival.
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(toast.message);
  }, [toast.message]);
  return (
    <Animated.View
      entering={motionPresets.bannerIn}
      pointerEvents="box-none"
      accessibilityRole="alert"
      testID={`toast-${toast.variant}`}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: mixHex(accent, theme.colors.surface, 0.5),
          borderRadius: theme.radii.md,
        },
      ]}
    >
      <View style={[styles.accentBar, { backgroundColor: accent }]} testID="toast-accent" />
      <View style={[styles.body, { gap: theme.spacing.sm, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }]}>
        <Text variant="body" color="secondary" style={styles.message} testID="toast-message">
          {toast.message}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          testID="toast-dismiss"
          onPress={() => useToastStore.getState().dismissToast(toast.id)}
          // The glyph is the desktop's 14; the touch target is the 44 pt floor.
          hitSlop={(theme.minTouchSize - DISMISS_GLYPH_SIZE) / 2}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <X size={DISMISS_GLYPH_SIZE} color={theme.colors.textMuted} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    alignItems: 'flex-end',
    zIndex: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    maxWidth: '100%',
    overflow: 'hidden',
    borderWidth: 1,
    elevation: 8,
    shadowOpacity: ELEVATION_SHADOW_OPACITY,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  accentBar: {
    width: ACCENT_BAR_WIDTH,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flexShrink: 1,
  },
  message: {
    flexShrink: 1,
  },
});
