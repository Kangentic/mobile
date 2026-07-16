import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { AppTabBar } from '@/components/navigation/AppTabBar';
import { useActivityStore } from '@/state/activityStore';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

type AppTabBarProps = React.ComponentProps<typeof AppTabBar>;

const mockEmit = jest.fn();
const mockNavigate = jest.fn();

/**
 * A minimal stand-in for expo-router's JS tab bar renderer props: only the
 * fields AppTabBar actually reads (route key/name, focus index, per-route
 * options, emit/navigate). The real BottomTabBarProps type is vendored and
 * not exported for reuse, so this is cast through `unknown` rather than
 * hand-copying react-navigation's shape.
 */
function buildTabBarProps(focusedRouteName: 'index' | 'board'): AppTabBarProps {
  const routes = [
    { key: 'index-key', name: 'index' },
    { key: 'board-key', name: 'board' },
  ];
  const focusedIndex = routes.findIndex((route) => route.name === focusedRouteName);
  return {
    state: { index: focusedIndex, routes },
    descriptors: {
      'index-key': { options: { title: 'Home', tabBarButtonTestID: 'home-tab' } },
      'board-key': { options: { title: 'Board', tabBarButtonTestID: 'board-tab' } },
    },
    navigation: { emit: mockEmit, navigate: mockNavigate },
  } as unknown as AppTabBarProps;
}

function seedNeedsYouSession(): void {
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
  useActivityStore.getState().applyActivityEvent({
    kind: 'activity',
    sessionId: 'sess-1',
    taskId: 'task-1',
    payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: true },
  });
}

describe('AppTabBar', () => {
  beforeEach(() => {
    mockEmit.mockReset();
    mockEmit.mockReturnValue({ defaultPrevented: false });
    mockNavigate.mockClear();
    useActivityStore.getState().reset();
  });

  it('marks the focused tab as selected and the other tab as not selected', () => {
    render(
      <ThemeProvider>
        <AppTabBar {...buildTabBarProps('index')} />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('home-tab').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('board-tab').props.accessibilityState).toEqual({ selected: false });
  });

  it('shows no needs-you dot on Home when nothing is pending', () => {
    render(
      <ThemeProvider>
        <AppTabBar {...buildTabBarProps('board')} />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('tab-index-attention')).toBeNull();
  });

  it('shows the needs-you dot on Home when a session needs the user and Home is not the focused tab', () => {
    seedNeedsYouSession();
    render(
      <ThemeProvider>
        <AppTabBar {...buildTabBarProps('board')} />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('tab-index-attention')).toBeTruthy();
  });

  it('hides the needs-you dot when Home is the focused tab, even with a pending session', () => {
    seedNeedsYouSession();
    render(
      <ThemeProvider>
        <AppTabBar {...buildTabBarProps('index')} />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('tab-index-attention')).toBeNull();
  });

  it('navigates when the unfocused tab is tapped', () => {
    render(
      <ThemeProvider>
        <AppTabBar {...buildTabBarProps('index')} />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('board-tab'));

    expect(mockEmit).toHaveBeenCalledWith({ type: 'tabPress', target: 'board-key', canPreventDefault: true });
    expect(mockNavigate).toHaveBeenCalledWith('board');
  });

  it('does not renavigate when the already-focused tab is tapped', () => {
    render(
      <ThemeProvider>
        <AppTabBar {...buildTabBarProps('index')} />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('home-tab'));

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
