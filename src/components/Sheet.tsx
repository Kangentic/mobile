import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  testID: string;
  title?: string;
  children: React.ReactNode;
}

const SLIDE_IN_DURATION_MS = 220;

/**
 * Bottom sheet on a transparent RN Modal: a dimmed backdrop that dismisses on
 * press, and a slide-up surface card (react-native-reanimated entering
 * animation) with safe-area-aware bottom padding.
 */
export function Sheet({ visible, onClose, testID, title, children }: SheetProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable
          testID={`${testID}-backdrop`}
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.backdrop }]}
        />
        <Animated.View
          testID={testID}
          entering={SlideInDown.duration(SLIDE_IN_DURATION_MS)}
          style={{
            backgroundColor: theme.colors.surfaceRaised,
            borderTopLeftRadius: theme.radii.lg,
            borderTopRightRadius: theme.radii.lg,
            padding: theme.spacing.lg,
            paddingBottom: theme.spacing.lg + insets.bottom,
            gap: theme.spacing.md,
          }}
        >
          {title !== undefined && <Text variant="title">{title}</Text>}
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
});
