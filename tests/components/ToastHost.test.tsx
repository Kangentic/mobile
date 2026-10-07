import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider, ToastHost } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { TOAST_DURATION_MS, useToastStore } from '@/state/toastStore';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

async function renderHost(): Promise<void> {
  await render(
    <ThemeProvider>
      <ToastHost />
    </ThemeProvider>,
  );
}

/**
 * The desktop's toast, on the phone (kangentic ToastItem.tsx): a surface card
 * with the variant's accent bar, the message, and a dismiss X; it closes on
 * its own, and the card itself takes no touches.
 */
describe('ToastHost', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useToastStore.getState().reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('draws nothing while no toast is up', async () => {
    await renderHost();
    expect(screen.queryByTestId('toast-host')).toBeNull();
  });

  it('draws a warning toast with the warning accent bar and its message', async () => {
    await renderHost();
    await act(() => {
      useToastStore.getState().addToast({ message: 'Failed to resume session', variant: 'warning' });
    });

    expect(screen.getByTestId('toast-message')).toHaveTextContent('Failed to resume session');
    expect(StyleSheet.flatten(screen.getByTestId('toast-accent').props.style).backgroundColor).toBe(darkTerminalTheme.colors.warning);
  });

  it('closes on its own after the desktop\'s duration', async () => {
    await renderHost();
    await act(() => {
      useToastStore.getState().addToast({ message: 'Failed to resume session', variant: 'warning' });
    });

    await act(() => {
      jest.advanceTimersByTime(TOAST_DURATION_MS);
    });

    expect(screen.queryByTestId('toast-host')).toBeNull();
  });

  it('closes early from its dismiss X', async () => {
    await renderHost();
    await act(() => {
      useToastStore.getState().addToast({ message: 'Failed to resume session', variant: 'warning' });
    });

    await fireEvent.press(screen.getByTestId('toast-dismiss'));

    expect(screen.queryByTestId('toast-host')).toBeNull();
  });

  /**
   * The desktop's ToastItem rule: the card sits over live controls (here the
   * session footer's composer), so only the X may take a touch.
   */
  it('lets touches through the card and the stack, to whatever sits under them', async () => {
    await renderHost();
    await act(() => {
      useToastStore.getState().addToast({ message: 'Failed to resume session', variant: 'warning' });
    });

    expect(screen.getByTestId('toast-host').props.pointerEvents).toBe('box-none');
    expect(screen.getByTestId('toast-warning').props.pointerEvents).toBe('box-none');
  });
});
