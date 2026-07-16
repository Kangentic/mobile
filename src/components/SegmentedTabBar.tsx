import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { triggerHaptic } from '@/lib/haptics';
import { useTheme } from './theme/ThemeProvider';
import { MonoText } from './MonoText';
import { Badge } from './Badge';

export interface SegmentedTabBarItem {
  key: string;
  label: string;
  badgeCount?: number;
}

export interface SegmentedTabBarProps {
  items: SegmentedTabBarItem[];
  activeKey: string;
  onChange: (key: string) => void;
  testID: string;
  /** Caption-size labels for dense placements; the 44pt touch target is kept. */
  compact?: boolean;
}

const ACTIVE_UNDERLINE_HEIGHT = 2;

/**
 * A row of equal-width segments with mono labels, an accent underline on the
 * active segment, and an optional count Badge per item. Each segment gets the
 * stable testID `${testID}-${item.key}`.
 */
export function SegmentedTabBar({ items, activeKey, onChange, testID, compact = false }: SegmentedTabBarProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View testID={testID} style={[styles.bar, { borderBottomColor: theme.colors.border }]}>
      {items.map((item) => {
        const isActive = item.key === activeKey;
        return (
          <Pressable
            key={item.key}
            testID={`${testID}-${item.key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            onPress={() => {
              // Selection-changed haptic only on an actual change; re-tapping
              // the active segment stays silent.
              if (!isActive) triggerHaptic('modeToggled');
              onChange(item.key);
            }}
            style={({ pressed }) => [
              styles.segment,
              {
                minHeight: theme.minTouchSize,
                gap: theme.spacing.xs,
                borderBottomColor: isActive ? theme.colors.accent : 'transparent',
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <MonoText size={compact ? 'caption' : 'body'} color={isActive ? 'accent' : 'secondary'}>
              {item.label}
            </MonoText>
            {item.badgeCount !== undefined && (
              <Badge label={String(item.badgeCount)} color={isActive ? 'accent' : 'secondary'} testID={`${testID}-${item.key}-badge`} />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: ACTIVE_UNDERLINE_HEIGHT,
  },
});
