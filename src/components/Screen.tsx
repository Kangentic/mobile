import React from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from './theme/ThemeProvider';

export interface ScreenProps extends ViewProps {
  children?: React.ReactNode;
  /**
   * Safe-area edges this screen consumes. The TOP is deliberately never a
   * default: every screen has a header that owns the status-bar inset (the
   * native navigator header, or a custom header padding insets.top), so a
   * top edge here double-insets and opens a dead gap under the header. Tab
   * screens pass [] because the tab bar owns the bottom inset too.
   */
  edges?: Edge[];
}

const DEFAULT_EDGES: Edge[] = ['bottom', 'left', 'right'];

export function Screen({ children, style, edges = DEFAULT_EDGES, ...rest }: ScreenProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <SafeAreaView edges={edges} style={[styles.safeArea, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.content, style]} {...rest}>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    flex: 1,
  },
});
