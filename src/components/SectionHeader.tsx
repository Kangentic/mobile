import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Badge } from './Badge';
import { Icon } from './Icon';
import { Row } from './Row';
import { Text } from './Text';

export interface SectionHeaderProps {
  title: string;
  testID?: string;
  /**
   * How many rows this section holds. Only meaningful alongside `onToggle`
   * (a static label, like Settings' groups, has nothing to disclose) -
   * shown so the count stays visible even while collapsed.
   */
  count?: number;
  /** Provided together: renders a tappable disclosure row (chevron + count) instead of a plain static label. Omit both for the plain variant. */
  collapsed?: boolean;
  onToggle?: () => void;
}

/**
 * A list section label. Plain by default (Settings' groups); pass `count`
 * + `collapsed` + `onToggle` together for the collapsible variant (the
 * Agents feed's Idle/Thinking headers) - a tappable disclosure row with
 * its count visible whether expanded or collapsed.
 */
export function SectionHeader({ title, testID, count, collapsed, onToggle }: SectionHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const paddingStyle = {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.lg,
    paddingBottom: theme.spacing.sm,
  };

  if (!onToggle) {
    return (
      <View testID={testID} style={paddingStyle}>
        <Text variant="title" color="secondary">
          {title}
        </Text>
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      accessibilityLabel={`${title}, ${count ?? 0}, ${collapsed ? 'collapsed' : 'expanded'}`}
      onPress={onToggle}
      style={[paddingStyle, { minHeight: theme.minTouchSize }]}
    >
      <Row gap="xs" style={styles.row}>
        <Text variant="title" color="secondary">
          {title}
        </Text>
        {/* pill + compact: rounded and visible enough to read as a real
            count (secondary color, matching the title's own weight), but
            tight enough to stay visibly smaller than the title beside it. */}
        {count !== undefined ? <Badge label={String(count)} shape="pill" compact align="center" /> : null}
        <View style={styles.flex} />
        <Icon name={collapsed ? 'chevron-forward' : 'chevron-down'} color="muted" size={18} />
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
