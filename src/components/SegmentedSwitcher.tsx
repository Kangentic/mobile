import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { LucideIcon } from 'lucide-react-native';
import { bezierEasing } from './motion/presets';
import { StatusDot } from './StatusDot';
import { Text } from './Text';
import { useTheme } from './theme/ThemeProvider';
import { triggerHaptic } from '@/lib/haptics';

export interface SegmentOption<Mode extends string> {
  mode: Mode;
  label: string;
  accessibilityLabel: string;
  Icon: LucideIcon;
}

export interface SegmentedSwitcherProps<Mode extends string> {
  options: SegmentOption<Mode>[];
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  /**
   * Segment that should carry a needs-you dot, or null for none. Never
   * auto-switches - it marks where attention is wanted, it does not take it.
   */
  attentionMode?: Mode | null;
  /**
   * Prefix for this instance's testIDs: the bar is `<prefix>-toggle` and each
   * segment `<prefix>-<mode>`. A prop rather than a constant because E2E flows
   * select on these, so two switchers must not answer to the same selector.
   */
  testIDPrefix: string;
}

/** Tall enough to anchor a screen as primary navigation rather than read as a compact form control. */
const SEGMENT_HEIGHT = 52;
const SEGMENT_ICON_SIZE = 19;

/**
 * A full-width surface switcher: N segments, one active, with an indicator
 * that SLIDES between positions rather than a fill that pops on and off, so
 * the eye tracks the change instead of re-finding it. The indicator is a
 * single shared element whose x-position is animated; per-segment opacity
 * crossfades would drift out of step.
 *
 * Deliberately CUSTOM rather than a native segmented control, which is the
 * opposite of the call made for the bottom tab bar - and the difference is
 * what each one is. A tab bar is platform CHROME: iOS users read its
 * translucency and behaviour as correctness, so approximating it is a risk.
 * This is in-screen CONTENT, where a branded control reads as the app's
 * design rather than as a mistake, and where the platform controls actively
 * fight the brief: Material's segmented button is a compact utilitarian
 * control, and neither it nor UIKit's exposes a per-segment icon slot
 * through @expo/ui.
 */
export function SegmentedSwitcher<Mode extends string>({
  options,
  mode,
  onModeChange,
  attentionMode = null,
  testIDPrefix,
}: SegmentedSwitcherProps<Mode>): React.JSX.Element {
  const theme = useTheme();
  const { durations, easing } = theme.motion;
  const [barWidth, setBarWidth] = useState(0);
  const segmentWidth = barWidth > 0 ? barWidth / options.length : 0;
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.mode === mode),
  );

  // Starts at its resting position so the initially-active segment renders
  // already lit, with no slide-in on mount.
  const indicatorOffset = useSharedValue(0);
  const hasMeasured = useSharedValue(false);
  useEffect(() => {
    // Bail until the row has actually been measured. The first render always
    // has segmentWidth 0 (onLayout cannot fire before it commits), so without
    // this the "first layout" branch below burns itself on that pass, landing
    // the indicator at 0. The real measurement then arrives as an ANIMATION
    // from the first slot - visible whenever the screen opens on another
    // mode, which the needs-you rows do routinely by landing on chat.
    if (segmentWidth === 0) return;
    const target = activeIndex * segmentWidth;
    if (!hasMeasured.get()) {
      // First real layout: land it, do not animate from zero.
      hasMeasured.set(true);
      indicatorOffset.set(target);
      return;
    }
    indicatorOffset.set(
      withTiming(target, {
        duration: durations.base,
        easing: bezierEasing(easing.decelerate),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [activeIndex, segmentWidth, indicatorOffset, hasMeasured, durations.base, easing.decelerate]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorOffset.get() }],
  }));

  function onLayout(event: LayoutChangeEvent): void {
    const nextWidth = event.nativeEvent.layout.width;
    setBarWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
  }

  return (
    <View
      testID={`${testIDPrefix}-toggle`}
      onLayout={onLayout}
      style={[
        styles.bar,
        {
          height: SEGMENT_HEIGHT,
          backgroundColor: theme.colors.surfaceRaised,
          borderRadius: theme.radii.lg,
        },
      ]}
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            indicatorStyle,
            {
              width: segmentWidth,
              backgroundColor: theme.colors.accentSubtle,
              borderRadius: theme.radii.lg,
            },
          ]}
        />
      ) : null}

      {options.map((option) => {
        const isActive = option.mode === mode;
        return (
          <Pressable
            key={option.mode}
            testID={`${testIDPrefix}-${option.mode}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={option.accessibilityLabel}
            onPress={() => {
              if (isActive) return;
              triggerHaptic('modeToggled');
              onModeChange(option.mode);
            }}
            style={styles.segment}
          >
            <View style={styles.iconHolder}>
              <option.Icon
                size={SEGMENT_ICON_SIZE}
                color={isActive ? theme.colors.accent : theme.colors.textMuted}
                strokeWidth={isActive ? 2.4 : 1.8}
              />
              {option.mode === attentionMode ? (
                <View style={styles.attentionDot}>
                  <StatusDot variant="needs-you" testID={`${testIDPrefix}-${option.mode}-attention`} />
                </View>
              ) : null}
            </View>
            <Text variant="caption" color={isActive ? 'accent' : 'muted'} style={styles.label}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  attentionDot: {
    position: 'absolute',
    right: -9,
    top: -2,
  },
  bar: {
    flexDirection: 'row',
    // The indicator is absolutely positioned against this box.
    position: 'relative',
  },
  iconHolder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  indicator: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
  },
  label: {
    fontWeight: '600',
    marginTop: 3,
  },
  segment: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
