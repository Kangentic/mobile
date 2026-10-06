import React, { useMemo } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, CirclePause, Clock } from 'lucide-react-native';
import { AgentStatusIcon, Stack, Text, useTheme } from '@/components';
import { useActivityStore } from '@/state/activityStore';
import { useSettingsStore } from '@/state/settingsStore';
import { FEED_SECTION_DISPLAY_TITLES, countFeedSectionsByTitle } from './home/feedSections';

/**
 * Every row's height, the whole row being one tap target: Material 3's 48 dp
 * minimum, which also clears the 44 pt iOS minimum and the app's 44.
 */
const ROW_HEIGHT = 48;
const GLYPH_SIZE = 16;
const CHECKBOX_SIZE = 22;
const CHECKBOX_RADIUS = 6;

/**
 * Which of the Agents feed's four sections show, as a native form sheet route
 * opened from the feed header's filter button. Agents tab only: the Board has
 * no sections. A tap applies at once and is remembered on this phone
 * (`hiddenTriageSections`).
 *
 * The row control follows each platform's own pick-several list, settled on
 * Material 3 and Apple's HIG (design review round 5): Android draws Material's
 * leading checkbox and tints a ticked row; iOS, which has no checkbox style,
 * draws the trailing checkmark of an inclusive selection list, untinted - the
 * idiom Apple's own Calendar uses to choose which calendars show. A switch was
 * considered and rejected: both guidelines keep it for an independent on/off
 * setting, not a choice from one related list.
 *
 * All four are always listed, with how many sessions each holds, so a
 * preference can be set before a section has anything in it.
 */
export function SectionFilterScreen(): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const bySessionId = useActivityStore((state) => state.bySessionId);
  const hiddenTriageSections = useSettingsStore((state) => state.hiddenTriageSections);
  const countsByTitle = useMemo(() => countFeedSectionsByTitle(bySessionId), [bySessionId]);
  const anyHidden = hiddenTriageSections.length > 0;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          paddingHorizontal: theme.spacing.sm,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.lg + insets.bottom,
        },
      ]}
      testID="section-filter-sheet"
    >
      <Stack gap="sm">
        <Text variant="title" style={{ paddingHorizontal: theme.spacing.md }}>
          Show sections
        </Text>
        <View>
          {FEED_SECTION_DISPLAY_TITLES.map((title) => (
            <SectionRow
              key={title}
              title={title}
              count={countsByTitle.get(title) ?? 0}
              shown={!hiddenTriageSections.includes(title)}
              onToggle={() => void useSettingsStore.getState().toggleTriageSectionHidden(title)}
            />
          ))}
        </View>
        <Pressable
          testID="section-filter-show-all"
          accessibilityRole="button"
          accessibilityState={{ disabled: !anyHidden }}
          disabled={!anyHidden}
          onPress={() => void useSettingsStore.getState().showAllTriageSections()}
          android_ripple={{ color: theme.colors.border }}
          style={({ pressed }) => [
            styles.showAll,
            {
              minHeight: ROW_HEIGHT,
              borderTopColor: theme.colors.border,
              opacity: pressed && Platform.OS === 'ios' ? 0.6 : 1,
            },
          ]}
        >
          <Text variant="body" color={anyHidden ? 'accent' : 'muted'}>
            Show all
          </Text>
        </Pressable>
      </Stack>
    </View>
  );
}

function SectionRow({
  title,
  count,
  shown,
  onToggle,
}: {
  title: string;
  count: number;
  shown: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const isIos = Platform.OS === 'ios';
  return (
    <Pressable
      testID={`section-filter-row-${title.toLowerCase()}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: shown }}
      accessibilityLabel={`${title}, ${count} ${count === 1 ? 'session' : 'sessions'}`}
      onPress={onToggle}
      android_ripple={{ color: theme.colors.border }}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: ROW_HEIGHT,
          gap: theme.spacing.md,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radii.md,
          // Material marks a selected list item on the whole row; iOS lists do
          // not tint, and show a press highlight instead.
          backgroundColor: !isIos && shown ? theme.colors.accentSubtle : isIos && pressed ? theme.colors.surfaceRaised : 'transparent',
        },
      ]}
    >
      {isIos ? null : <Checkbox checked={shown} testID={`section-filter-row-${title.toLowerCase()}-checkbox`} />}
      <View style={styles.glyph}>
        <SectionGlyph title={title} />
      </View>
      <Text variant="body" color="primary" numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      <Text variant="caption" color="muted" style={styles.count}>
        {String(count)}
      </Text>
      {isIos ? (
        <View style={styles.trailingCheck} testID={`section-filter-row-${title.toLowerCase()}-checkmark`}>
          {shown ? <Check size={18} color={theme.colors.accent} strokeWidth={2.6} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Material's checkbox: an outlined square, filled in the accent with a check when ticked. Presentational; the row owns the role and the tap. */
function Checkbox({ checked, testID }: { checked: boolean; testID: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.checkbox,
        {
          borderColor: checked ? theme.colors.accent : theme.colors.textMuted,
          backgroundColor: checked ? theme.colors.accent : 'transparent',
        },
      ]}
    >
      {checked ? <Check size={15} color={theme.colors.onAccent} strokeWidth={3.2} /> : null}
    </View>
  );
}

/** The glyph each section's cards or session header wear, so the row says what it would hide. */
function SectionGlyph({ title }: { title: string }): React.JSX.Element | null {
  const theme = useTheme();
  switch (title) {
    case 'Idle':
      return <AgentStatusIcon kind="idle" size={GLYPH_SIZE} />;
    case 'Active':
      return <AgentStatusIcon kind="working" size={GLYPH_SIZE} />;
    case 'Queued':
      return <Clock size={GLYPH_SIZE} color={theme.colors.textMuted} />;
    case 'Paused':
      return <CirclePause size={GLYPH_SIZE} color={theme.colors.textMuted} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  glyph: {
    width: GLYPH_SIZE,
    alignItems: 'center',
  },
  title: {
    flex: 1,
  },
  count: {
    fontVariant: ['tabular-nums'],
  },
  trailingCheck: {
    width: 20,
    alignItems: 'center',
  },
  checkbox: {
    width: CHECKBOX_SIZE,
    height: CHECKBOX_SIZE,
    borderRadius: CHECKBOX_RADIUS,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  showAll: {
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
