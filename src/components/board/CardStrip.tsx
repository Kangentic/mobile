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

/**
 * The band across the top of a card, shared by every strip so they cannot
 * drift, as the desktop's CardStrip is: the column strip (the Agents feed's
 * project and track, a workflow task's workflow and route) and the
 * automations strip. One shape means one thing on a card: something outside
 * the column holds it, or says where it is.
 *
 * Flush to the card's edges: the card pads its content by md, so the band
 * cancels it on three sides and the top corners follow the card's own (inner)
 * radius. The same height on every branch, so a band never changes the
 * card's height by what it holds.
 */
export function CardStrip({ testID, accessibilityLabel, children }: CardStripProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.strip,
        {
          marginTop: -theme.spacing.md,
          marginHorizontal: -theme.spacing.md,
          borderTopLeftRadius: theme.radii.md - StyleSheet.hairlineWidth,
          borderTopRightRadius: theme.radii.md - StyleSheet.hairlineWidth,
          backgroundColor: theme.colors.surfaceInset,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      {children}
    </View>
  );
}

/**
 * Across the top of a card whose column automations are disabled (protocol
 * 0.22.0): the desktop's strip, in the column strip's shell, with no hue, so
 * it competes with neither the activity mark nor a workflow's color. A
 * workflow task never wears it, since joining a workflow clears the switch,
 * so it never meets the workflow strip in the one slot both use.
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
  strip: {
    height: CARD_STRIP_HEIGHT,
    marginBottom: STRIP_GAP_BELOW,
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
