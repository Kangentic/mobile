import React, { useEffect, type ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bot, SquareKanban } from 'lucide-react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StatusDot } from '../StatusDot';
import { Text } from '../Text';
import { useTheme } from '../theme/ThemeProvider';
import { PressScale } from '../motion/PressScale';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';
import { triggerHaptic } from '@/lib/haptics';

const TAB_ICON_SIZE = 22;
/**
 * Fixed pill geometry: Android renders a borderRadius far beyond the
 * view's size inconsistently across re-renders (the stadium collapsed to
 * a box after a tab switch), so the radius is pinned to half a known
 * height instead of an oversized token.
 */
const TAB_PILL_HEIGHT = 32;

// The renderer props for expo-router's JS tabs bar, derived from the public
// Tabs component surface (the underlying react-navigation type is vendored
// and not re-exported).
type TabsProps = ComponentProps<typeof Tabs>;
type BottomTabBarProps = Parameters<NonNullable<TabsProps['tabBar']>>[0];

interface TabVisual {
  label: string;
  Icon: typeof Bot;
}

// The first tab is the AGENTS feed (the product's home): every agent
// session top-down by priority - needs-you, then active, then idle,
// newest first within each group.
const TAB_VISUALS: Record<string, TabVisual> = {
  index: { label: 'Agents', Icon: Bot },
  board: { label: 'Board', Icon: SquareKanban },
};

/**
 * The custom bottom navigation bar: a Material 3-style active pill behind
 * the focused tab's icon, in Warm Craft tokens. Home grows a needs-you dot
 * whenever any session is waiting on the user, so attention is visible
 * from anywhere in the tabs. Owns the gesture-nav bottom inset.
 */
export function AppTabBar({ state, descriptors, navigation }: BottomTabBarProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const hasNeedsYou = useActivityStore((storeState) =>
    Object.values(storeState.bySessionId).some((entry) => sectionForEntry(entry) === 'needs-you'),
  );

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          paddingBottom: insets.bottom + theme.spacing.xs,
          paddingTop: theme.spacing.xs,
        },
      ]}
    >
      {state.routes.map((route, routeIndex) => {
        const { options } = descriptors[route.key];
        const isFocused = state.index === routeIndex;
        const visual = TAB_VISUALS[route.name] ?? { label: options.title ?? route.name, Icon: Bot };
        const showAttentionDot = route.name === 'index' && hasNeedsYou && !isFocused;

        const onPress = (): void => {
          const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
          if (!isFocused && !event.defaultPrevented) {
            triggerHaptic('modeToggled');
            navigation.navigate(route.name);
          }
        };

        return (
          <TabBarItem
            key={route.key}
            testID={options.tabBarButtonTestID}
            isFocused={isFocused}
            visual={visual}
            showAttentionDot={showAttentionDot}
            attentionTestID={`tab-${route.name}-attention`}
            onPress={onPress}
          />
        );
      })}
    </View>
  );
}

/**
 * One tab: a PressScale depth press plus the M3 active-pill fill, which
 * grows/fades in on focus instead of an instant color swap - reanimated
 * `withTiming` at the motion tokens' base duration and decelerate easing
 * (the same "entering" feel as the rest of the app), honoring
 * `ReduceMotion.System` like every other animated primitive here.
 */
function TabBarItem({
  testID,
  isFocused,
  visual,
  showAttentionDot,
  attentionTestID,
  onPress,
}: {
  testID: string | undefined;
  isFocused: boolean;
  visual: TabVisual;
  showAttentionDot: boolean;
  attentionTestID: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const { durations, easing } = theme.motion;
  // Starts already at its resting value so the initially-focused tab renders
  // a filled pill with no animate-in flash.
  const focusProgress = useSharedValue(isFocused ? 1 : 0);

  useEffect(() => {
    focusProgress.set(
      withTiming(isFocused ? 1 : 0, {
        duration: durations.base,
        easing: Easing.bezier(easing.decelerate.x1, easing.decelerate.y1, easing.decelerate.x2, easing.decelerate.y2),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [isFocused, focusProgress, durations.base, easing.decelerate]);

  const pillFillStyle = useAnimatedStyle(() => ({
    opacity: focusProgress.get(),
    transform: [{ scale: 0.85 + 0.15 * focusProgress.get() }],
  }));

  return (
    <PressScale
      testID={testID}
      accessibilityRole="tab"
      accessibilityState={{ selected: isFocused }}
      accessibilityLabel={visual.label}
      onPress={onPress}
      style={styles.item}
    >
      <View
        style={[
          styles.iconPill,
          {
            height: TAB_PILL_HEIGHT,
            paddingHorizontal: theme.spacing.lg,
          },
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pillFill,
            pillFillStyle,
            {
              // M3 active indicator: a full stadium, not a rounded box.
              borderRadius: TAB_PILL_HEIGHT / 2,
              backgroundColor: theme.colors.accentSubtle,
            },
          ]}
        />
        <visual.Icon
          size={TAB_ICON_SIZE}
          color={isFocused ? theme.colors.accent : theme.colors.textMuted}
          strokeWidth={isFocused ? 2.4 : 1.8}
        />
        {showAttentionDot ? (
          <View style={styles.attentionDot}>
            <StatusDot variant="needs-you" testID={attentionTestID} />
          </View>
        ) : null}
      </View>
      <Text variant="caption" color={isFocused ? 'accent' : 'muted'} style={styles.label}>
        {visual.label}
      </Text>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 56,
  },
  iconPill: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  attentionDot: {
    position: 'absolute',
    top: 0,
    right: 8,
  },
  label: {
    marginTop: 2,
    fontWeight: '600',
  },
});
