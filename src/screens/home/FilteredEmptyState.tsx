import React from 'react';
import { Button, EmptyState, useTheme } from '@/components';
import { useSettingsStore } from '@/state/settingsStore';
import { FEED_SECTION_DISPLAY_TITLES } from './feedSections';

/**
 * Sessions exist, but the section filter hides every one of them. Says so,
 * with the way back, rather than reading as "All quiet", which would be false.
 */
export function FilteredEmptyState(): React.JSX.Element {
  const theme = useTheme();
  const hiddenTriageSections = useSettingsStore((state) => state.hiddenTriageSections);
  const hiddenCount = hiddenTriageSections.length;
  const everySectionHidden = FEED_SECTION_DISPLAY_TITLES.every((title) => hiddenTriageSections.includes(title));
  return (
    <EmptyState
      testID="filtered-empty-state"
      title={everySectionHidden ? 'All sections hidden' : 'Nothing in the shown sections'}
      // The count only adds anything when some sections are still shown: with
      // all of them hidden it repeats the title (ui-copy-brevity).
      caption={everySectionHidden ? undefined : hiddenCount === 1 ? '1 section is hidden.' : `${hiddenCount} sections are hidden.`}
      overseerSize={90}
    >
      <Button
        label="Show all"
        onPress={() => void useSettingsStore.getState().showAllTriageSections()}
        testID="filtered-empty-show-all"
        style={{ paddingHorizontal: theme.spacing.xxl * 2 }}
      />
    </EmptyState>
  );
}
