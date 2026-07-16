import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { ColumnChipBar } from '@/components/board/ColumnChipBar';

// NOTE: the scroll-into-view effect (scrollRef.current.scrollTo on
// activeIndex change) is deliberately NOT covered here. ColumnChipBar reads
// it off an imperative ScrollView ref, and RNTL never runs a real layout
// pass, so observing it requires either partial-mocking `react-native`'s
// ScrollView (spiking jest-expo's native module bootstrap: mocking the
// module breaks TurboModuleRegistry.getEnforcing('DevMenu') deep inside
// jest-expo's setup) or spying on the ScrollView instance directly (not
// reachable: the ref is internal to ColumnChipBar, never exposed as a
// prop). Both were tried; both fight the test environment rather than the
// component under test. See the AppHeader/AppTabBar/ColumnChipBar audit
// report for the recommendation to leave this uncovered rather than write
// a test that mocks around, not exercises, the real scroll behavior.

function buildColumn(id: string, name: string, position: number): BoardColumnWire {
  return {
    id,
    name,
    description: null,
    role: null,
    position,
    color: '#3fb950',
    icon: null,
    is_archived: false,
    is_ghost: false,
  };
}

describe('ColumnChipBar', () => {
  const columns: BoardColumnWire[] = [buildColumn('lane-todo', 'To Do', 0), buildColumn('lane-doing', 'Doing', 1)];
  const taskCounts = [2, 0];

  it('renders a named, counted chip per column and marks the active one', () => {
    render(
      <ThemeProvider>
        <ColumnChipBar columns={columns} taskCounts={taskCounts} activeIndex={0} onSelect={jest.fn()} />
      </ThemeProvider>,
    );

    expect(screen.getByText('To Do')).toBeTruthy();
    expect(screen.getByText('Doing')).toBeTruthy();
    expect(screen.getByTestId('board-column-chip-lane-todo').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('board-column-chip-lane-doing').props.accessibilityState).toEqual({ selected: false });
  });

  it('calls onSelect with the tapped column index', () => {
    const onSelect = jest.fn();
    render(
      <ThemeProvider>
        <ColumnChipBar columns={columns} taskCounts={taskCounts} activeIndex={0} onSelect={onSelect} />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('board-column-chip-lane-doing'));

    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
