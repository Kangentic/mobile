import React, { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';
import { useMotionPresets } from './motion/presets';
import { useDeferredUnmount } from './motion/useDeferredUnmount';

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
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
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
              backgroundColor: theme.colors.surfaceOverlay,
              borderTopLeftRadius: theme.radii.lg,
              borderTopRightRadius: theme.radii.lg,
              padding: theme.spacing.lg,
              paddingBottom: theme.spacing.lg + insets.bottom,
              gap: theme.spacing.md,
            }}
          >
            {title !== undefined && <Text variant="title">{title}</Text>}
            {children}
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
});
