import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Icon, useTheme } from '@/components';
import { useSettingsStore } from '@/state/settingsStore';

const ACTIVE_DOT_SIZE = 8;

/**
 * The Agents header's section filter: opens the Show sections sheet. The same
 * 44 pt target and glyph treatment as the Settings button beside it, plus an
 * accent dot while any section is hidden, so a filtered feed never passes for
 * an empty one.
 */
export function SectionFilterButton(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const hiddenCount = useSettingsStore((state) => state.hiddenTriageSections.length);
  const filtered = hiddenCount > 0;
  return (
    <Pressable
      testID="header-section-filter-button"
      accessibilityRole="button"
      accessibilityLabel={filtered ? `Show sections, ${hiddenCount} hidden` : 'Show sections'}
      onPress={() => router.push('/section-filter')}
      style={({ pressed }) => [styles.target, { minWidth: theme.minTouchSize, minHeight: theme.minTouchSize, opacity: pressed ? 0.7 : 1 }]}
    >
      <View>
        <Icon name="filter" color={filtered ? 'accent' : 'secondary'} />
        {filtered ? (
          <View
            testID="header-section-filter-dot"
            style={[styles.dot, { backgroundColor: theme.colors.accent, borderColor: theme.colors.surface }]}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  target: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    position: 'absolute',
    top: -2,
    right: -3,
    width: ACTIVE_DOT_SIZE,
    height: ACTIVE_DOT_SIZE,
    borderRadius: ACTIVE_DOT_SIZE / 2,
    borderWidth: 1.5,
  },
});
