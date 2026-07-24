import React, { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { Badge, Row, Text, useTheme } from '@/components';
import { getColumnIcon } from './columnIcons';

export interface ColumnChipBarProps {
  columns: BoardColumnWire[];
  /** Task count per column, index-aligned with `columns`. */
  taskCounts: number[];
  activeIndex: number;
  onSelect: (columnIndex: number) => void;
}

const CHIP_DOT_SIZE = 8;
const CHIP_ICON_SIZE = 14;

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
      {columns.map((column, columnIndex) => {
        const isActive = columnIndex === activeIndex;
        const ColumnIcon = getColumnIcon(column);
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
                minHeight: theme.minTouchSize,
                borderRadius: theme.radii.md,
                paddingHorizontal: theme.spacing.md,
                backgroundColor: isActive ? theme.colors.surfaceRaised : 'transparent',
                borderColor: isActive ? theme.colors.accentMuted : theme.colors.border,
              },
            ]}
          >
            <Row gap="sm" style={styles.chipContent}>
              <Row gap="xs" style={styles.chipIdentity}>
                {/* The desktop's column icon (its own icon picker, tinted
                    with the column's color), falling back to a plain color
                    dot for a column with neither a custom icon nor a
                    matching role default - never a fill, always a small
                    tinted glyph. */}
                {ColumnIcon !== null ? (
                  <ColumnIcon size={CHIP_ICON_SIZE} color={column.color} strokeWidth={2} />
                ) : column.color ? (
                  <View style={[styles.colorDot, { backgroundColor: column.color }]} />
                ) : null}
                <Text variant="caption" color={isActive ? 'accent' : 'secondary'}>
                  {column.name}
                </Text>
              </Row>
              {/* The count reads as a neutral tally, not a second accented
                  element - active state is already carried by the chip's
                  border and the name's color, so the pill stays flat and
                  unbordered (no double hairline against the chip's own).
                  An empty column shows no pill at all: a row of "0"s on a
                  fresh board is noise, and the bare chip already reads as
                  empty. */}
              {(taskCounts[columnIndex] ?? 0) > 0 ? (
                <Badge label={String(taskCounts[columnIndex] ?? 0)} color="muted" shape="pill" outlined={false} />
              ) : null}
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
  chipIdentity: {
    alignItems: 'center',
  },
  colorDot: {
    width: CHIP_DOT_SIZE,
    height: CHIP_DOT_SIZE,
    borderRadius: CHIP_DOT_SIZE / 2,
  },
});
