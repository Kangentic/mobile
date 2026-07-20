import React, { type ComponentProps } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Bot, SquareKanban } from 'lucide-react-native';
import { StatusDot } from '../StatusDot';
import { Text } from '../Text';
import { useTheme } from '../theme/ThemeProvider';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';
import { triggerHaptic } from '@/lib/haptics';

const TAB_ICON_SIZE = 22;

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
          <Pressable
            key={route.key}
            testID={options.tabBarButtonTestID}
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
                  // M3 active indicator: a full stadium, not a rounded box.
                  borderRadius: theme.radii.full,
                  paddingHorizontal: theme.spacing.lg,
                  paddingVertical: theme.spacing.xs,
                  backgroundColor: isFocused ? theme.colors.accentSubtle : 'transparent',
                },
              ]}
            >
              <visual.Icon
                size={TAB_ICON_SIZE}
                color={isFocused ? theme.colors.accent : theme.colors.textMuted}
                strokeWidth={isFocused ? 2.4 : 1.8}
              />
              {showAttentionDot ? (
                <View style={styles.attentionDot}>
                  <StatusDot variant="needs-you" testID={`tab-${route.name}-attention`} />
                </View>
              ) : null}
            </View>
            <Text variant="caption" color={isFocused ? 'accent' : 'muted'} style={styles.label}>
              {visual.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
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
