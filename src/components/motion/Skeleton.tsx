import React from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import { PulsingBlock } from './PulsingBlock';
import { useScreenMotionActive } from './ScreenMotion';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A loading placeholder block with a slow opacity pulse (the theme's
 * skeletonPulse timing). Under OS reduced motion, or while the screen is
 * blurred, the pulse is skipped and the block rests at the pulse's mid opacity,
 * so it still reads as "loading" without movement - and registers no Reanimated
 * mapper at all, because the animating half (`PulsingBlock`, which owns the
 * shared value and the animated style) is a separate component mounted only
 * on that branch. A loading container renders a fixed set of these, so the
 * count is not one.
 *
 * FlashList hard rule: skeletons never render inside a recycled renderItem;
 * loading branches render a fixed set of them at the container level.
 */
export function Skeleton({ width = '100%', height = 14, borderRadius, style, testID }: SkeletonProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const { durationMs, opacityMin, opacityMax } = theme.motion.skeletonPulse;
  const restingOpacity = (opacityMin + opacityMax) / 2;
  const baseStyle: ViewStyle = {
    width,
    height,
    borderRadius: borderRadius ?? theme.radii.sm,
    backgroundColor: theme.colors.surfaceRaised,
  };

  // A pulse nobody can see costs the same as one they can. Resting at the mid
  // opacity is exactly what reduced motion does, so a blurred skeleton still
  // reads as "loading".
  if (reducedMotion || !screenMotionActive) {
    return <View testID={testID} style={[baseStyle, { opacity: restingOpacity }, style]} />;
  }

  return (
    <PulsingBlock
      baseStyle={baseStyle}
      style={style}
      testID={testID}
      durationMs={durationMs}
      opacityMin={opacityMin}
      opacityMax={opacityMax}
      easing={theme.motion.easing.standard}
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
