import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/tokens';
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
 * The sheet never grows past this fraction of the screen. Exported so a
 * sheet with its own internally-scrolling element (e.g. CreateTaskSheet's
 * description field) can size that element to fill the same budget, rather
 * than hardcoding a second, possibly-drifting copy of this number.
 */
export const SHEET_MAX_HEIGHT_FRACTION = 0.75;

export interface SheetDescriptionBoundsParams {
  theme: Theme;
  windowHeight: number;
  bottomInset: number;
  /** Whether this sheet has a column-chips row between the description and
   * its action button (CreateTaskSheet does, EditTaskSheet does not). */
  hasColumnChipsRow: boolean;
}

/**
 * The min/max height for a sheet's multiline description field: it fills
 * whatever this sheet's SHEET_MAX_HEIGHT_FRACTION budget leaves after the
 * OTHER fixed rows (the sheet's own title, the title field, an optional
 * column-chips row, the action button, and the sheet's own paddings) - not
 * a small fixed cap, which left a large dead gap above a short sheet
 * instead of giving a long description more visible room to read. A small
 * safety buffer absorbs the rest: this is an estimate of Sheet's actual
 * layout, not a measurement of it, and undershooting cuts off the action
 * button, which is worse than a slightly-shorter description.
 */
export function computeSheetDescriptionBounds({
  theme,
  windowHeight,
  bottomInset,
  hasColumnChipsRow,
}: SheetDescriptionBoundsParams): { descriptionMinHeight: number; descriptionMaxHeight: number } {
  const chromeEstimateSafetyBuffer = theme.spacing.md;
  const reservedChromeHeight =
    theme.spacing.lg + // Sheet's own paddingTop
    theme.typography.title.lineHeight +
    theme.spacing.md + // Sheet's own title + its marginBottom
    theme.minTouchSize + // title field
    theme.spacing.sm + // title field + gap
    theme.spacing.sm + // gap from description to the next row
    (hasColumnChipsRow ? theme.minTouchSize + theme.spacing.sm : 0) + // column chips row + gap
    theme.minTouchSize + // the sheet's action button (Create / Save)
    theme.spacing.lg + // Sheet's own paddingBottom
    bottomInset + // Sheet's paddingBottom also adds the real safe-area inset
    chromeEstimateSafetyBuffer;
  const descriptionMinHeight = theme.typography.body.lineHeight * 3 + theme.spacing.sm * 2;
  const descriptionMaxHeight = Math.max(
    windowHeight * SHEET_MAX_HEIGHT_FRACTION - reservedChromeHeight,
    descriptionMinHeight,
  );
  return { descriptionMinHeight, descriptionMaxHeight };
}

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
