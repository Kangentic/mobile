import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronsUpDown } from 'lucide-react-native';
import { Brandmark } from './brand/Brandmark';
import { Icon } from './Icon';
import { Row } from './Row';
import { Text } from './Text';
import { useTheme } from './theme/ThemeProvider';

export interface AppHeaderProps {
  title: string;
  /** Caption under the title (e.g. the section name when the title is a project). */
  subtitle?: string;
  /** When set, the title block becomes a pressable switcher and grows a chevron. */
  onTitlePress?: () => void;
  testID?: string;
}

const BRANDMARK_SIZE = 28;

/**
 * The tab screens' chrome: brandmark, title (optionally a switcher), and the
 * settings affordance. Owns the status-bar inset so screens keep their
 * no-top-edge SafeArea discipline.
 */
export function AppHeader({ title, subtitle, onTitlePress, testID = 'app-header' }: AppHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const titleBlock = (
    <View style={styles.titleBlock}>
      <Row gap="xs" style={styles.titleRow}>
        <Text variant="title" numberOfLines={1}>
          {title}
        </Text>
        {onTitlePress ? <ChevronsUpDown size={16} color={theme.colors.textSecondary} /> : null}
      </Row>
      {subtitle ? (
        <Text variant="caption" color="muted" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );

  return (
    <Row
      gap="sm"
      testID={testID}
      style={[
        styles.header,
        {
          paddingTop: insets.top + theme.spacing.xs,
          paddingBottom: theme.spacing.xs,
          paddingHorizontal: theme.spacing.md,
          backgroundColor: theme.colors.surface,
          borderBottomColor: theme.colors.border,
        },
      ]}
    >
      <Brandmark size={BRANDMARK_SIZE} testID={`${testID}-brandmark`} />
      {onTitlePress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Switch project (current: ${title})`}
          testID={`${testID}-title`}
          onPress={onTitlePress}
          style={({ pressed }) => [styles.titlePressable, { opacity: pressed ? 0.7 : 1 }]}
        >
          {titleBlock}
        </Pressable>
      ) : (
        <View style={styles.titlePressable} testID={`${testID}-title`}>
          {titleBlock}
        </View>
      )}
      <Pressable
        testID="header-settings-button"
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push('/settings')}
        style={{
          minWidth: theme.minTouchSize,
          minHeight: theme.minTouchSize,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="settings-outline" color="secondary" />
      </Pressable>
    </Row>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  titlePressable: {
    flex: 1,
    justifyContent: 'center',
    minHeight: 44,
  },
  titleBlock: {
    justifyContent: 'center',
  },
  titleRow: {
    alignItems: 'center',
  },
});
