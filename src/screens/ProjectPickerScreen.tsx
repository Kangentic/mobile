import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Stack, Text, useTheme } from '@/components';
import { useBoardStore } from '@/state/boardStore';

/**
 * Which project the Board tab shows, as a native form sheet route.
 *
 * The selection lands in the board store rather than being handed back
 * through a callback: a route has no parent to call. BoardScreen reacts to
 * the store, which also lets it reset the visible column itself instead of
 * the picker reaching across to do it.
 */
export function ProjectPickerScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const projects = useBoardStore((state) => state.projects);
  const selectedProjectId = useBoardStore((state) => state.selectedProjectId);
  const selectProject = useBoardStore((state) => state.selectProject);
  const currentProjectId = selectedProjectId ?? projects[0]?.id ?? null;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.xl + insets.bottom,
        },
      ]}
      testID="board-project-sheet"
    >
      <Stack gap="xs">
        <Text variant="title">Projects</Text>
        {projects.map((project) => (
          <Pressable
            key={project.id}
            testID={`board-project-${project.id}`}
            accessibilityRole="radio"
            accessibilityState={{ selected: project.id === currentProjectId }}
            onPress={() => {
              selectProject(project.id);
              router.back();
            }}
            style={{ minHeight: theme.minTouchSize, justifyContent: 'center', paddingHorizontal: theme.spacing.md }}
          >
            <Text variant="body" color={project.id === currentProjectId ? 'primary' : 'secondary'}>
              {project.name}
            </Text>
          </Pressable>
        ))}
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
});
