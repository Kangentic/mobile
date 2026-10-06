import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ThemeProvider, EmptyState, Button } from '@/components';

// The Overseer subtree is hidden from accessibility (decorative art), which
// also hides it from default RNTL queries.
const HIDDEN = { includeHiddenElements: true } as const;

describe('EmptyState', () => {
  it('renders the title, caption, and its Overseer', async () => {
    await render(
      <ThemeProvider>
        <EmptyState testID="quiet-state" title="All quiet" caption="Nothing needs you right now." />
      </ThemeProvider>,
    );

    expect(screen.getByText('All quiet')).toBeTruthy();
    expect(screen.getByText('Nothing needs you right now.')).toBeTruthy();
    expect(screen.getByTestId('quiet-state-overseer', HIDDEN)).toBeTruthy();
  });

  it('sizes the Overseer from overseerSize (default 90)', async () => {
    await render(
      <ThemeProvider>
        <EmptyState testID="quiet-state" title="All quiet" />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('quiet-state-overseer', HIDDEN).props.style);
    expect(flattenedStyle.width).toBe(90);
  });

  it('renders and forwards presses to the CTA slot', async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <EmptyState testID="quiet-state" title="No desktop paired">
          <Button label="Pair with your desktop" onPress={onPress} testID="pair-cta" />
        </EmptyState>
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('pair-cta'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('omits the caption node when no caption is given', async () => {
    await render(
      <ThemeProvider>
        <EmptyState testID="quiet-state" title="No changes" />
      </ThemeProvider>,
    );

    expect(screen.getByText('No changes')).toBeTruthy();
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();
  });
});
