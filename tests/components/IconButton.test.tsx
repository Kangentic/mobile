import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { ThemeProvider, IconButton } from '@/components';
import type { IconButtonVariant } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';

const { colors } = darkTerminalTheme;

async function renderIconButton(variant: IconButtonVariant | undefined, badge?: React.ReactNode): Promise<void> {
  await render(
    <ThemeProvider>
      <IconButton iconName="settings" onPress={jest.fn()} testID="icon-button" accessibilityLabel="Settings" variant={variant} badge={badge} />
    </ThemeProvider>,
  );
}

function iconButtonSurfaceStyle(): ViewStyle {
  return StyleSheet.flatten(screen.getByTestId('icon-button').props.style as StyleProp<ViewStyle>) as ViewStyle;
}

describe('IconButton', () => {
  it('fires onPress when tapped', async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <IconButton iconName="send" onPress={onPress} testID="composer-send" accessibilityLabel="Send message" />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('composer-send'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire onPress when disabled', async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <IconButton iconName="send" onPress={onPress} testID="composer-send" accessibilityLabel="Send message" disabled />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('composer-send'));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders the fab variant with the same testID and label', async () => {
    await render(
      <ThemeProvider>
        <IconButton iconName="add" onPress={jest.fn()} testID="board-add-task" accessibilityLabel="Add task" variant="fab" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('board-add-task')).toBeTruthy();
    expect(screen.getByLabelText('Add task')).toBeTruthy();
  });
});

/**
 * Regression cover for task #113 change 1: a naked-glyph icon button gave no
 * sign of where to tap (ui-conventions.md, visible tap targets), so `raised`
 * is the default and `plain` is opt-in for a control a container already frames.
 */
describe('IconButton variants', () => {
  it('defaults to the raised variant: a raised fill with a hairline outline', async () => {
    await renderIconButton(undefined);

    const surface = iconButtonSurfaceStyle();
    expect(surface.backgroundColor).toBe(colors.surfaceRaised);
    expect(surface.borderColor).toBe(colors.border);
    expect(surface.borderWidth).toBe(StyleSheet.hairlineWidth);
  });

  it('keeps the plain variant unfilled and unbordered, for a control a container already frames', async () => {
    await renderIconButton('plain');

    const surface = iconButtonSurfaceStyle();
    expect(surface.backgroundColor).toBeUndefined();
    expect(surface.borderWidth).toBeUndefined();
  });

  it('draws the fab variant as a solid accent circle with no outline', async () => {
    await renderIconButton('fab');

    const surface = iconButtonSurfaceStyle();
    expect(surface.backgroundColor).toBe(colors.accent);
    expect(surface.borderWidth).toBeUndefined();
  });
});

describe('IconButton badge', () => {
  it('renders the supplied badge node over the button', async () => {
    await renderIconButton(undefined, <View testID="icon-button-badge" />);

    expect(screen.getByTestId('icon-button-badge')).toBeTruthy();
  });

  it('renders no badge slot when none is supplied', async () => {
    await renderIconButton(undefined);

    expect(screen.queryByTestId('icon-button-badge')).toBeNull();
  });

  it('wraps the badge in a non-interactive view, so a dot over the corner cannot swallow the tap', async () => {
    await renderIconButton(undefined, <View testID="icon-button-badge" />);

    expect(screen.getByTestId('icon-button-badge').parent?.props.pointerEvents).toBe('none');
  });
});
