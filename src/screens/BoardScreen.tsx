import React from 'react';
import { StyleSheet, View } from 'react-native';
import PagerView from 'react-native-pager-view';
import { FlashList } from '@shopify/flash-list';
import { Screen, Card, Stack, Text, useTheme } from '@/components';
import { selectColumnsOrdered, selectTasksForColumn, type BoardTask } from '@/state/boardStore';

export function BoardScreen(): React.JSX.Element {
  const theme = useTheme();
  const columns = selectColumnsOrdered();

  return (
    <Screen testID="board-screen">
      <PagerView testID="board-pager" style={styles.pager} initialPage={0}>
        {columns.map((column) => (
          <View key={column.id} testID={`board-column-${column.id}`} style={styles.page}>
            <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
              <Text variant="title">{column.name}</Text>
            </View>
            <FlashList<BoardTask>
              testID={`board-column-${column.id}-list`}
              data={selectTasksForColumn(column.id)}
              keyExtractor={(task) => task.id}
              renderItem={({ item }) => (
                <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
                  <TaskCard task={item} />
                </View>
              )}
            />
          </View>
        ))}
      </PagerView>
    </Screen>
  );
}

const TaskCard = React.memo(function TaskCard({ task }: { task: BoardTask }): React.JSX.Element {
  return (
    <Card testID={`board-card-${task.id}`}>
      <Stack gap="xs">
        <Text variant="bodyStrong">{task.title}</Text>
        <Text variant="caption" color="secondary">
          {task.repository}
        </Text>
      </Stack>
    </Card>
  );
});

const styles = StyleSheet.create({
  pager: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
});
