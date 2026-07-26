import React from 'react';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTheme } from '@/components';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';

/**
 * Bottom tabs: Agents (the attention feed) and Board.
 *
 * NATIVE tabs, not a custom JS bar. The bar this replaced was not broken, but
 * it could only ever approximate the platform: iOS reads a tab bar's
 * translucency, its blur at the scroll edge, and its selection behaviour as
 * correctness signals, and none of that is reproducible from React Native
 * primitives. Since this project cannot test on iOS, "it probably looks right"
 * was not a safe assumption to ship.
 *
 * Icons are deliberately PLATFORM icons (SF Symbols via `sf`, Material via
 * `md`) rather than the lucide set the rest of the app uses. A tab bar is
 * platform chrome, where users expect their own platform's glyphs, and the
 * desktop app has no bottom tab bar for these to stay symmetric with. Content
 * icons (board columns, task cards, prompt cards) stay lucide precisely
 * BECAUSE they must match the desktop - see .claude/rules/ui-conventions.md.
 */
export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();
  // The needs-you signal, previously a custom dot drawn on the Agents tab.
  // A childless Badge is the platform's own dot, which also means it follows
  // the OS convention users already recognise from every other app.
  const hasNeedsYou = useActivityStore((state) =>
    Object.values(state.bySessionId).some((entry) => sectionForEntry(entry) === 'needs-you'),
  );

  return (
    <NativeTabs backgroundColor={theme.colors.surface} indicatorColor={theme.colors.accentSubtle}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="sparkles" md="auto_awesome" />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Badge hidden={!hasNeedsYou} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="board">
        <NativeTabs.Trigger.Icon sf="rectangle.split.3x1" md="view_kanban" />
        <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
