import React, { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { useTheme } from '@/components';
import { ColumnChip } from './ColumnChip';

export interface ColumnChipBarProps {
  columns: BoardColumnWire[];
  /** Task count per column, index-aligned with `columns`. */
  taskCounts: number[];
  activeIndex: number;
  onSelect: (columnIndex: number) => void;
}

/**
 * The board's column navigator: one named chip per column with its task
 * count, the active chip filled. Replaces anonymous page dots - the user
 * always sees WHERE they are and can jump straight to a named column
 * instead of swiping blind. Two-way synced with the board's PagerView:
 * tapping a chip pages the board, swiping the board moves the highlight
 * (and scrolls the active chip into view).
 */
export function ColumnChipBar({ columns, taskCounts, activeIndex, onSelect }: ColumnChipBarProps): React.JSX.Element {
  const theme = useTheme();
  const scrollRef = useRef<ScrollView>(null);
  const chipOffsetsRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    const chipOffset = chipOffsetsRef.current.get(activeIndex);
    if (chipOffset !== undefined) {
      scrollRef.current?.scrollTo({ x: Math.max(0, chipOffset - theme.spacing.lg), animated: true });
    }
  }, [activeIndex, theme.spacing.lg]);

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID="board-column-chips"
      contentContainerStyle={{ paddingHorizontal: theme.spacing.md, gap: theme.spacing.sm }}
      style={styles.bar}
    >
      {columns.map((column, columnIndex) => (
        <ColumnChip
          key={column.id}
          label={column.name}
          column={column}
          active={columnIndex === activeIndex}
          count={taskCounts[columnIndex] ?? 0}
          testID={`board-column-chip-${column.id}`}
          accessibilityRole="tab"
          accessibilityLabel={`${column.name}, ${taskCounts[columnIndex] ?? 0} tasks`}
          onPress={() => onSelect(columnIndex)}
          onLayout={(event) => {
            chipOffsetsRef.current.set(columnIndex, event.nativeEvent.layout.x);
          }}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexGrow: 0,
  },
});
