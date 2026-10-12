import React from 'react';
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { SheetActionRow, ThemeProvider, type SheetActionRowProps } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';

/**
 * SheetActionRow is the long-press sheets' shared row: the task actions hub and
 * a Command Terminal's sheet both draw their actions with it. Their own suites
 * cover what each sheet DOES with a row (what a press opens, which rows a state
 * disables, that every row sits on the raised surface). This file covers what the
 * row itself owes both: a disabled row is faded and inert, a destructive row's
 * label wears the danger ink, and a caption exists only when one is given.
 *
 * Mutations seen failing: pinning opacity to 1 ("Expected: 0.4, Received: 1"),
 * pinning the label ink to primary ("Expected: "#e05d5d", Received: "#f0e9dd""),
 * and mounting the caption Text unconditionally (two Text nodes in the row where
 * one was expected).
 */
const { colors } = darkTerminalTheme;
const ROW_TEST_ID = 'sheet-row';

async function renderRow(overrides: Partial<SheetActionRowProps> = {}): Promise<jest.Mock> {
  const onPress = jest.fn();
  const props: SheetActionRowProps = {
    label: 'Open terminal',
    glyph: <View testID="sheet-row-glyph" />,
    onPress,
    disabled: false,
    testID: ROW_TEST_ID,
    ...overrides,
  };
  await render(
    <ThemeProvider>
      <SheetActionRow {...props} />
    </ThemeProvider>,
  );
  return onPress;
}

function rowStyle(): ViewStyle {
  return StyleSheet.flatten(screen.getByTestId(ROW_TEST_ID).props.style as StyleProp<ViewStyle>) as ViewStyle;
}

function inkOf(text: string): unknown {
  return (StyleSheet.flatten(screen.getByText(text).props.style as StyleProp<TextStyle>) as TextStyle).color;
}

describe('SheetActionRow', () => {
  it('draws the glyph beside the label', async () => {
    await renderRow();

    const row = within(screen.getByTestId(ROW_TEST_ID));
    expect(row.getByTestId('sheet-row-glyph')).toBeTruthy();
    expect(row.getByText('Open terminal')).toBeTruthy();
  });

  describe('enabled', () => {
    it('fires onPress once per tap, at full strength', async () => {
      const onPress = await renderRow();

      expect(rowStyle().opacity).toBe(1);
      await fireEvent.press(screen.getByTestId(ROW_TEST_ID));

      expect(onPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('disabled', () => {
    it('fades to the sheet\'s disabled weight and reports itself disabled to a screen reader', async () => {
      await renderRow({ disabled: true });

      expect(rowStyle().opacity).toBe(0.4);
      expect(screen.getByTestId(ROW_TEST_ID).props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    });

    it('swallows a tap', async () => {
      const onPress = await renderRow({ disabled: true });

      await fireEvent.press(screen.getByTestId(ROW_TEST_ID));

      expect(onPress).not.toHaveBeenCalled();
    });
  });

  describe('the label\'s ink', () => {
    it('is primary by default', async () => {
      await renderRow();

      expect(inkOf('Open terminal')).toBe(colors.textPrimary);
    });

    it('is danger for a destructive row, so Stop and Delete read as such before they are read', async () => {
      await renderRow({ label: 'Stop terminal', color: 'danger' });

      expect(inkOf('Stop terminal')).toBe(colors.danger);
    });
  });

  describe('the caption', () => {
    it('sits under the label in the muted ink when given', async () => {
      await renderRow({ caption: 'No Done column on this board' });

      expect(inkOf('No Done column on this board')).toBe(colors.textMuted);
    });

    // Counts every Text in the row, empty ones included: an always-mounted
    // caption would hold a blank second line under every label.
    it('is absent, not an empty line, when none is given or it is null', async () => {
      await renderRow();
      expect(within(screen.getByTestId(ROW_TEST_ID)).queryAllByText(/.*/)).toHaveLength(1);

      await screen.unmount();
      await renderRow({ caption: null });
      expect(within(screen.getByTestId(ROW_TEST_ID)).queryAllByText(/.*/)).toHaveLength(1);
    });
  });
});
