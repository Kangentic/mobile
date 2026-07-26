import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StatusDot, Text, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';
import { SESSION_MODE_OPTIONS, type SessionMode } from './sessionModes';

export type { SessionMode } from './sessionModes';

export interface SessionModeToggleProps {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  /**
   * True when something on the chat side needs the user (a pending
   * permission/question) while another surface is showing: the Chat segment
   * grows a needs-you dot. Never auto-switches.
   */
  chatAttention: boolean;
}

/** Tall enough to anchor the screen as primary navigation rather than read as a compact form control. */
const SEGMENT_HEIGHT = 52;
const SEGMENT_ICON_SIZE = 19;

/**
 * The session's surface switcher: one session, three surfaces - Terminal,
 * Chat, Changes - as a full-width control anchoring the footer.
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
 *
 * The active segment is marked by an indicator that SLIDES between positions
 * rather than a fill that pops on and off, so the eye tracks the change
 * instead of re-finding it. It is a single shared element whose x-position is
 * animated; per-segment opacity crossfades would drift out of step.
 */
export function SessionModeToggle({ mode, onModeChange, chatAttention }: SessionModeToggleProps): React.JSX.Element {
  const theme = useTheme();
  const { durations, easing } = theme.motion;
  const [barWidth, setBarWidth] = useState(0);
  const segmentWidth = barWidth > 0 ? barWidth / SESSION_MODE_OPTIONS.length : 0;
  const activeIndex = Math.max(
    0,
    SESSION_MODE_OPTIONS.findIndex((option) => option.mode === mode),
  );

  // Starts at its resting position so the initially-active segment renders
  // already lit, with no slide-in on mount.
  const indicatorOffset = useSharedValue(0);
  const hasMeasured = useSharedValue(false);
  useEffect(() => {
    const target = activeIndex * segmentWidth;
    if (!hasMeasured.get()) {
      // First layout: land it, do not animate from zero.
      hasMeasured.set(true);
      indicatorOffset.set(target);
      return;
    }
    indicatorOffset.set(
      withTiming(target, {
        duration: durations.base,
        easing: Easing.bezier(easing.decelerate.x1, easing.decelerate.y1, easing.decelerate.x2, easing.decelerate.y2),
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
      testID="session-mode-toggle"
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

      {SESSION_MODE_OPTIONS.map((option) => {
        const isActive = option.mode === mode;
        return (
          <Pressable
            key={option.mode}
            testID={`session-mode-${option.mode}`}
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
              {option.mode === 'chat' && chatAttention ? (
                <View style={styles.attentionDot}>
                  <StatusDot variant="needs-you" testID="session-mode-chat-attention" />
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
