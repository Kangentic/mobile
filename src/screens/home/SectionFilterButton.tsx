import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { IconButton, useTheme } from '@/components';
import { useSettingsStore } from '@/state/settingsStore';

const ACTIVE_DOT_SIZE = 8;

/**
 * The Agents header's section filter: opens the Show sections sheet. The same
 * raised 44 pt button as the Settings button beside it, plus an accent dot on
 * the circle's edge while any section is hidden, so a filtered feed never
 * passes for an empty one.
 */
export function SectionFilterButton(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const hiddenCount = useSettingsStore((state) => state.hiddenTriageSections.length);
  const filtered = hiddenCount > 0;
  return (
    <IconButton
      iconName="filter"
      iconColor={filtered ? 'accent' : 'secondary'}
      testID="header-section-filter-button"
      accessibilityLabel={filtered ? `Show sections, ${hiddenCount} hidden` : 'Show sections'}
      onPress={() => router.push('/section-filter')}
      badge={
        filtered ? (
          <View
            testID="header-section-filter-dot"
            style={[styles.dot, { backgroundColor: theme.colors.accent, borderColor: theme.colors.surface }]}
          />
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  dot: {
    width: ACTIVE_DOT_SIZE,
    height: ACTIVE_DOT_SIZE,
    borderRadius: ACTIVE_DOT_SIZE / 2,
    borderWidth: 1.5,
  },
});
