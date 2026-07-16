import React, { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A loading placeholder block with a slow opacity pulse (the theme's
 * skeletonPulse timing). Under OS reduced motion the pulse is skipped and the
 * block rests at the pulse's mid opacity, so it still reads as "loading"
 * without movement.
 *
 * FlashList hard rule: skeletons never render inside a recycled renderItem;
 * loading branches render a fixed set of them at the container level.
 */
export function Skeleton({ width = '100%', height = 14, borderRadius, style, testID }: SkeletonProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const { durationMs, opacityMin, opacityMax } = theme.motion.skeletonPulse;
  const restingOpacity = (opacityMin + opacityMax) / 2;
  const pulseOpacity = useSharedValue(reducedMotion ? restingOpacity : opacityMax);

  useEffect(() => {
    if (reducedMotion) {
      pulseOpacity.value = restingOpacity;
      return;
    }
    pulseOpacity.value = opacityMax;
    pulseOpacity.value = withRepeat(
      withTiming(opacityMin, {
        duration: durationMs,
        easing: Easing.bezier(
          theme.motion.easing.standard.x1,
          theme.motion.easing.standard.y1,
          theme.motion.easing.standard.x2,
          theme.motion.easing.standard.y2,
        ),
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );
    return () => {
      cancelAnimation(pulseOpacity);
    };
  }, [reducedMotion, restingOpacity, opacityMin, opacityMax, durationMs, pulseOpacity, theme.motion.easing.standard]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulseOpacity.value }));

  return (
    <Animated.View
      testID={testID}
      style={[
        {
          width,
          height,
          borderRadius: borderRadius ?? theme.radii.sm,
          backgroundColor: theme.colors.surfaceRaised,
        },
        animatedStyle,
        style,
      ]}
    />
  );
}

export interface SkeletonRowProps {
  testID?: string;
}

/** A list-row-shaped skeleton: leading badge block, main line, trailing counts. */
export function SkeletonRow({ testID }: SkeletonRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.row,
        { gap: theme.spacing.sm, minHeight: theme.minTouchSize, paddingHorizontal: theme.spacing.md },
      ]}
    >
      <Skeleton width={28} height={16} />
      <Skeleton width="58%" height={14} />
      <View style={styles.rowSpacer} />
      <Skeleton width={40} height={12} />
    </View>
  );
}

export interface SkeletonCardProps {
  testID?: string;
}

/** A card-shaped skeleton: title line over two body lines, on a card surface. */
export function SkeletonCard({ testID }: SkeletonCardProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          padding: theme.spacing.md,
          gap: theme.spacing.sm,
        },
      ]}
    >
      <Skeleton width="55%" height={16} />
      <Skeleton width="100%" height={12} />
      <Skeleton width="35%" height={12} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowSpacer: {
    flex: 1,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
