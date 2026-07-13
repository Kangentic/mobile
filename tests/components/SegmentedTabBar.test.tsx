import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider, SegmentedTabBar } from '@/components';

const items = [
  { key: 'chat', label: 'Chat' },
  { key: 'diff', label: 'Diff', badgeCount: 3 },
  { key: 'terminal', label: 'Terminal' },
];

describe('SegmentedTabBar', () => {
  it('renders every item with its label and per-item testID', () => {
    render(
      <ThemeProvider>
        <SegmentedTabBar items={items} activeKey="chat" onChange={jest.fn()} testID="session-tabs" />
      </ThemeProvider>,
    );

    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('Diff')).toBeTruthy();
    expect(screen.getByText('Terminal')).toBeTruthy();
    expect(screen.getByTestId('session-tabs-chat')).toBeTruthy();
    expect(screen.getByTestId('session-tabs-diff')).toBeTruthy();
    expect(screen.getByTestId('session-tabs-terminal')).toBeTruthy();
  });

  it('fires onChange with the tapped item key', () => {
    const onChange = jest.fn();
    render(
      <ThemeProvider>
        <SegmentedTabBar items={items} activeKey="chat" onChange={onChange} testID="session-tabs" />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('session-tabs-diff'));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('diff');
  });

  it('marks only the active item as selected', () => {
    render(
      <ThemeProvider>
        <SegmentedTabBar items={items} activeKey="diff" onChange={jest.fn()} testID="session-tabs" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-tabs-diff').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('session-tabs-chat').props.accessibilityState).toEqual({ selected: false });
  });

  it('renders a count badge when badgeCount is set', () => {
    render(
      <ThemeProvider>
        <SegmentedTabBar items={items} activeKey="chat" onChange={jest.fn()} testID="session-tabs" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('session-tabs-diff-badge')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByTestId('session-tabs-chat-badge')).toBeNull();
  });
});
