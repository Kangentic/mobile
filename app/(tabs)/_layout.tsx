import React from 'react';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useTheme } from '@/components';

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
 *
 * THE BOARD TAB IS THE ONE EXCEPTION, and it is not an oversight.
 *
 * SF Symbols has no kanban glyph. The catalogue was searched for `kanban`,
 * `board`, `column` and `lane` against the exact symbol set our SDK types
 * against, and the only `column` hits are `building.columns` - a bank facade.
 * The nearest shapes are generic split rectangles (`rectangle.split.3x1` and
 * friends) which read as "split view", not "a board of tasks in lanes", and
 * next to Android's Material `view_kanban` they look like a different product.
 * So iOS gets Kangentic's own kanban mark instead, out of @kangentic/branding.
 * Its proportions follow lucide's `SquareKanban` - declared upstream as named
 * constants rather than vendored path data, see that package's
 * THIRD-PARTY-NOTICES.md - so it still reads as the same icon family as the
 * board's own lucide column chips and the desktop app.
 *
 * Getting that to actually reach iOS depends on two precedence rules in
 * expo-router's icon converters, both of which are easy to trip:
 *
 *   iOS     `sf` > `xcasset` > `src`. Leaving `sf` on this trigger would mean
 *           `src` is silently ignored and the old symbol keeps rendering, with
 *           no warning. That is why there is no `sf` below.
 *   Android `drawable` > `md` > `src`. `md` wins, so Android keeps its Material
 *           glyph and never sees the PNG.
 *
 * The glyph is no longer rasterised here. @kangentic/branding owns it (the
 * website and the desktop app render the same mark), and `npm run sync:branding`
 * copies its iOS tab rasters into assets/brand/ - so the PNGs are still
 * committed, and `sync:branding:check` in CI fails if they drift from the
 * package. Hand them over as shipped: iOS treats them as TEMPLATE images, where
 * colour is discarded and the alpha channel is the entire payload, so
 * compositing one onto a background would turn the whole tab slot into a tinted
 * block. Metro resolves the @2x/@3x siblings from the unsuffixed name below.
 */
/*
 * NO NEEDS-YOU BADGE ON THE AGENTS TAB.
 *
 * There was one - a childless `NativeTabs.Trigger.Badge`, the platform's own
 * red dot, shown whenever any session was waiting on the user. It was removed
 * deliberately, so do not reinstate it as an obvious missing affordance.
 *
 * It bought nothing the screen was not already saying. The Agents feed leads
 * with the sessions that need a turn, each card names the exact thing it is
 * waiting for ("Approve: npx jest tests/components"), and the section header
 * carries the count. The dot restated all of that as an unread-mail marker,
 * one glyph deep, with no way to tell what or how many - and it sat on top of
 * the tab icon, which is the one place in the bar where a mark reads as an
 * alert rather than as information.
 */
export default function TabsLayout(): React.JSX.Element {
  const theme = useTheme();

  return (
    <NativeTabs
      backgroundColor={theme.colors.surface}
      indicatorColor={theme.colors.accentSubtle}
      // Icon and label colors must be stated, not inherited.
      //
      // Setting only `indicatorColor` left the SELECTED icon at Material's
      // default `onSecondaryContainer`, which is a near-black glyph - drawn on
      // top of our dark `accentSubtle` pill, so the selected tab read as a
      // smudge while the unselected one was clearly legible. It is the one
      // place in the app where selection reduced contrast instead of raising
      // it, and it shipped into every store screenshot before anyone looked.
      //
      // These are the same three tokens SegmentedSwitcher uses for exactly this
      // state (accentSubtle fill, accent glyph, muted when inactive), so the
      // platform tab bar and our own in-app switcher finally agree.
      iconColor={{ default: theme.colors.textMuted, selected: theme.colors.accent }}
      labelStyle={{
        default: { color: theme.colors.textMuted },
        selected: { color: theme.colors.accent },
      }}
    >
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="sparkles" md="auto_awesome" />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="board">
        {/*
          No `sf` here ON PURPOSE - see the note at the top of this file. iOS
          resolves sf > xcasset > src, so an SF Symbol on this trigger would
          silently win and the PNG would never render.

          `renderingMode` is stated rather than inferred. It already defaults to
          'template' whenever a tab bar icon colour is set, and one IS set
          above, so this changes nothing today - but the default is derived from
          that colour, and dropping `iconColor` would flip this icon to
          'original', which ignores the bar's tint entirely and so renders the
          selected and unselected states identically. Naming it makes the icon's
          tinting independent of a prop three elements away.

          The packaged raster paints its glyph WHITE under the alpha (this repo's
          old rasteriser used black). Under 'template' that is invisible either
          way, since UIKit keeps only the alpha - but it is why the file looks
          blank in an image viewer, which is not a broken asset.
        */}
        <NativeTabs.Trigger.Icon
          md="view_kanban"
          src={require('../../assets/brand/kanban-tab.png')}
          renderingMode="template"
        />
        <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
