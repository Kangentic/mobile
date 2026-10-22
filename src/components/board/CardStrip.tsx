import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Ban } from 'lucide-react-native';
import { Text, useTheme } from '@/components';

/*
 * The band's frame is the desktop's own measurements, copied 1:1 from its
 * CardStrip (kangentic #732, CardStrip.tsx). They are deliberately literal
 * rather than spacing tokens: the token scale has no 5 or 10, and rounding to
 * it is exactly the drift this component exists to avoid.
 */
export const CARD_STRIP_HEIGHT = 29;
const STRIP_INSET = 10;
const STRIP_GAP_BELOW = 8;
/** The gap between a band's groups, and inside the column strip's right-hand group. */
export const CARD_STRIP_GROUP_GAP = 8;
/** The desktop's automations strip (task-card-view.tsx): a 12 glyph at stroke 2, a 5 gap. */
const AUTOMATIONS_ICON_SIZE = 12;
const AUTOMATIONS_ICON_STROKE = 2;
const AUTOMATIONS_LABEL_GAP = 5;

/** The desktop's tooltip on its strip. A phone has no hover, so it is what a screen reader hears instead. */
export const AUTOMATIONS_DISABLED_DESCRIPTION = "Column automations don't run for this task. Enable them from the card's menu.";

export interface CardStripProps {
  testID: string;
  accessibilityLabel?: string;
  children: React.ReactNode;
}

export interface CardStripBleedProps {
  testID: string;
  /** The card's strips, top to bottom. */
  children: React.ReactNode;
}

/**
 * The wrapper around a card's strips, the desktop's `cardStripBleedClass`
 * (kangentic #877, CardStrip.tsx): flush to the card's edges, its top corners
 * following the card's own (inner) radius, and the desktop's 8 below. The card
 * pads its content by md, so the wrapper cancels it on three sides.
 *
 * One wrapper around however many strips the card wears, so a stack of them
 * meets the card's corners as one piece and no strip carries a margin of its
 * own: a held task's Agents card stacks the automations strip above its
 * column strip, as the desktop's Agent Monitor card does.
 */
export function CardStripBleed({ testID, children }: CardStripBleedProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.bleed,
        {
          marginTop: -theme.spacing.md,
          marginHorizontal: -theme.spacing.md,
          borderTopLeftRadius: theme.radii.md - StyleSheet.hairlineWidth,
          borderTopRightRadius: theme.radii.md - StyleSheet.hairlineWidth,
        },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * One band across the top of a card, shared by every strip so they cannot
 * drift, as the desktop's CardStrip is: the column strip (the Agents feed's
 * project and track, a workflow task's workflow and route) and the
 * automations strip. One shape means one thing on a card: something outside
 * the column holds it, or says where it is.
 *
 * The same height on every branch, so a band never changes the card's height
 * by what it holds. It sits inside a CardStripBleed, which places it.
 */
export function CardStrip({ testID, accessibilityLabel, children }: CardStripProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      style={[styles.strip, { backgroundColor: theme.colors.surfaceInset, borderBottomColor: theme.colors.border }]}
    >
      {children}
    </View>
  );
}

/**
 * Across the top of a card whose column automations are disabled (protocol
 * 0.22.0): the desktop's strip, in the column strip's shell, with no hue, so
 * it competes with neither the activity mark nor a workflow's color. On the
 * Board it is the card's only strip. On the Agents feed it stacks above the
 * column strip, as the desktop's Agent Monitor card stacks it (kangentic
 * #877). A workflow task never wears it, since joining a workflow clears the
 * switch, and the flag alone decides, as it does on the desktop.
 *
 * Static by design - no animated hooks (see ColumnStrip).
 */
export const AutomationsDisabledStrip = React.memo(function AutomationsDisabledStrip({
  testID,
}: {
  /** Root testID; the glyph's wrapper is `-icon`. */
  testID: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <CardStrip testID={testID} accessibilityLabel={AUTOMATIONS_DISABLED_DESCRIPTION}>
      <View style={styles.automations}>
        {/* The testID rides a wrapping View: lucide forwards `testID` as the
            web-only `data-testid`, which neither RNTL nor Maestro can select. */}
        <View testID={`${testID}-icon`}>
          <Ban size={AUTOMATIONS_ICON_SIZE} strokeWidth={AUTOMATIONS_ICON_STROKE} color={theme.colors.textMuted} />
        </View>
        <Text variant="caption" color="muted" numberOfLines={1} style={styles.automationsLabel}>
          Automations disabled
        </Text>
      </View>
    </CardStrip>
  );
});

const styles = StyleSheet.create({
  bleed: {
    marginBottom: STRIP_GAP_BELOW,
    // Clips the first strip's fill to the rounded top corners.
    overflow: 'hidden',
  },
  strip: {
    height: CARD_STRIP_HEIGHT,
    paddingHorizontal: STRIP_INSET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: CARD_STRIP_GROUP_GAP,
    borderBottomWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  automations: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: AUTOMATIONS_LABEL_GAP,
    flexShrink: 1,
    minWidth: 0,
  },
  automationsLabel: {
    flexShrink: 1,
  },
});
