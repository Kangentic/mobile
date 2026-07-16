import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { Row, Text, useTheme } from '@/components';

export interface ColumnChipBarProps {
  columns: BoardColumnWire[];
  /** Task count per column, index-aligned with `columns`. */
  taskCounts: number[];
  activeIndex: number;
  onSelect: (columnIndex: number) => void;
}

const CHIP_DOT_SIZE = 8;

/**
 * The board's column navigator: one named chip per column with its task
 * count, the active chip filled. Replaces anonymous page dots - the user
 * always sees WHERE they are and can jump straight to a named column
 * instead of swiping blind. Two-way synced with the pager: tapping a chip
 * pages the board, swiping the board moves the highlight (and scrolls the
 * active chip into view).
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
      {columns.map((column, columnIndex) => {
        const isActive = columnIndex === activeIndex;
        return (
          <Pressable
            key={column.id}
            testID={`board-column-chip-${column.id}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={`${column.name}, ${taskCounts[columnIndex] ?? 0} tasks`}
            onPress={() => onSelect(columnIndex)}
            onLayout={(event) => {
              chipOffsetsRef.current.set(columnIndex, event.nativeEvent.layout.x);
            }}
            style={[
              styles.chip,
              {
                minHeight: theme.minTouchSize - theme.spacing.xs,
                borderRadius: theme.radii.md,
                paddingHorizontal: theme.spacing.md,
                backgroundColor: isActive ? theme.colors.surfaceRaised : 'transparent',
                borderColor: isActive ? theme.colors.accentMuted : theme.colors.border,
              },
            ]}
          >
            <Row gap="xs" style={styles.chipContent}>
              {/* The desktop's column color, as recorded data (a dot, never a fill). */}
              {column.color ? (
                <View style={[styles.colorDot, { backgroundColor: column.color }]} />
              ) : null}
              <Text variant="caption" color={isActive ? 'accent' : 'secondary'}>
                {column.name}
              </Text>
              <Text variant="caption" color="muted">
                {taskCounts[columnIndex] ?? 0}
              </Text>
            </Row>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexGrow: 0,
  },
  chip: {
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipContent: {
    alignItems: 'center',
  },
  colorDot: {
    width: CHIP_DOT_SIZE,
    height: CHIP_DOT_SIZE,
    borderRadius: CHIP_DOT_SIZE / 2,
  },
});
