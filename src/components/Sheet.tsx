import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';
import { useMotionPresets } from './motion/presets';
import { useDeferredUnmount } from './motion/useDeferredUnmount';
import { SHEET_MAX_HEIGHT_FRACTION } from './sheetLayout';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  testID: string;
  title?: string;
  children: React.ReactNode;
}

/**
 * Extra time the Modal stays mounted past the exit animation's duration, so
 * the last exit frames are never clipped by the Modal teardown.
 */
const EXIT_UNMOUNT_GRACE_MS = 80;

// SHEET_MAX_HEIGHT_FRACTION and computeSheetDescriptionBounds live in the
// RN-free ./sheetLayout module (so vitest can unit-test the pure height
// math without pulling in react-native) and are re-exported here so every
// existing `from '@/components/Sheet'` / barrel import keeps working.
export { SHEET_MAX_HEIGHT_FRACTION, computeSheetDescriptionBounds, type SheetDescriptionBoundsParams } from './sheetLayout';

/**
 * Bottom sheet on a transparent RN Modal: a fading dimmed backdrop that
 * dismisses on press, and a slide-up surface card. The Modal itself stays
 * mounted through the exit animation (useDeferredUnmount), so closing plays
 * the slide-down + backdrop fade instead of vanishing.
 */
export function Sheet({ visible, onClose, testID, title, children }: SheetProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const motionPresets = useMotionPresets();
  // The backdrop's exit pairs with sheetSlideOut's fast timing; built here
  // because the presets module deliberately exposes only the closed named set.
  const backdropFadeOut = useMemo(
    () => FadeOut.duration(theme.motion.durations.fast).reduceMotion(ReduceMotion.System),
    [theme.motion.durations.fast],
  );
  const shouldRenderModal = useDeferredUnmount(visible, theme.motion.durations.fast + EXIT_UNMOUNT_GRACE_MS);

  if (!shouldRenderModal) {
    return null;
  }

  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      // Android's Dialog-backed Modal otherwise stops short of the app's own
      // edge-to-edge chrome (the custom tab bar), leaving it visible and
      // tappable beneath the sheet - these draw the dialog window fully
      // edge-to-edge so the backdrop and sheet genuinely cover it, matching
      // a native drawer. The sheet's own content still respects the real
      // safe-area inset via `insets.bottom` below.
      statusBarTranslucent
      navigationBarTranslucent
    >
      <View style={styles.overlay}>
        {visible ? (
          <Animated.View
            entering={motionPresets.crossfadeIn}
            exiting={backdropFadeOut}
            style={StyleSheet.absoluteFill}
          >
            <Pressable
              testID={`${testID}-backdrop`}
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.backdrop }]}
            />
          </Animated.View>
        ) : null}
        {visible ? (
          <Animated.View
            testID={testID}
            entering={motionPresets.sheetSlideIn}
            exiting={motionPresets.sheetSlideOut}
            style={{
              // Capped so unbounded content (a long typed description, a
              // long project/column list) scrolls internally instead of
              // pushing the sheet - and whatever's at its bottom, like a
              // submit button - off the edge of the screen entirely.
              maxHeight: `${SHEET_MAX_HEIGHT_FRACTION * 100}%`,
              backgroundColor: theme.colors.surfaceOverlay,
              borderTopLeftRadius: theme.radii.lg,
              borderTopRightRadius: theme.radii.lg,
              paddingTop: theme.spacing.lg,
              paddingBottom: theme.spacing.lg + insets.bottom,
            }}
          >
            {title !== undefined ? (
              <Text variant="title" style={{ paddingHorizontal: theme.spacing.lg, marginBottom: theme.spacing.md }}>
                {title}
              </Text>
            ) : null}
            <ScrollView
              // flexShrink (not flex/flexGrow): a short sheet still sizes
              // snugly to its content; only once the content would exceed
              // the SHEET_MAX_HEIGHT_FRACTION cap does this shrink to the
              // available space and start scrolling internally instead of
              // pushing past it.
              style={styles.scrollShrink}
              contentContainerStyle={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md }}
              keyboardShouldPersistTaps="handled"
            >
              {children}
            </ScrollView>
          </Animated.View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrollShrink: {
    flexShrink: 1,
  },
});
