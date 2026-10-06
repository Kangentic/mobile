import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { StyleSheet, View, type ColorValue, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import type { JsonNode } from 'test-renderer';
import { ThemeProvider, Button } from '@/components';
import type { ButtonVariant } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';

const { colors } = darkTerminalTheme;

async function renderButton(variant: ButtonVariant | undefined, leading?: React.ReactNode): Promise<void> {
  await render(
    <ThemeProvider>
      <Button label="Resume" onPress={jest.fn()} testID="button" variant={variant} leading={leading} />
    </ThemeProvider>,
  );
}

function buttonSurfaceStyle(): ViewStyle {
  return StyleSheet.flatten(screen.getByTestId('button').props.style as StyleProp<ViewStyle>) as ViewStyle;
}

function labelInk(): ColorValue | undefined {
  const labelStyle = StyleSheet.flatten(screen.getByText('Resume').props.style as StyleProp<TextStyle>) as TextStyle;
  return labelStyle.color;
}

/**
 * The rendered host tree as one compact string, so a structural assertion fails
 * with a readable diff rather than a dump of the whole React fiber. A View is
 * `View#testID`, or `Row` when it has no testID and lays out horizontally (the
 * `Row` primitive); a Text is `Text(content)`. Test Renderer's toJSON() returns
 * one element or null, never the array the previous react-test-renderer
 * returned for a multi-root tree, so there is no array case to join.
 */
function outline(node: JsonNode | null): string {
  if (node === null) {
    return 'null';
  }
  if (typeof node === 'string') {
    return node;
  }
  const children = node.children.map(outline).join(', ');
  if (node.type === 'Text') {
    return `Text(${children})`;
  }
  const flattenedStyle = StyleSheet.flatten(node.props.style as StyleProp<ViewStyle>) as ViewStyle | undefined;
  const label = node.props.testID !== undefined ? `View#${String(node.props.testID)}` : flattenedStyle?.flexDirection === 'row' ? 'Row' : 'View';
  return `${label}(${children})`;
}

describe('Button variants', () => {
  it('draws the tinted variant as an accent wash with a 1-wide accent-muted outline and accent ink', async () => {
    await renderButton('tinted');

    const surface = buttonSurfaceStyle();
    expect(surface.backgroundColor).toBe(colors.accentSubtle);
    expect(surface.borderWidth).toBe(1);
    expect(surface.borderColor).toBe(colors.accentMuted);
    // The desktop's in-place action takes the accent itself as ink, not onAccent
    // (which is for solid fills and would vanish on a pale wash).
    expect(labelInk()).toBe(colors.accent);
  });

  it('keeps onAccent ink on the solid primary fill, with no outline', async () => {
    await renderButton('primary');

    const surface = buttonSurfaceStyle();
    expect(surface.backgroundColor).toBe(colors.accent);
    expect(surface.borderWidth).toBeUndefined();
    expect(labelInk()).toBe(colors.onAccent);
  });

  it('defaults to the primary variant', async () => {
    await renderButton(undefined);

    expect(buttonSurfaceStyle().backgroundColor).toBe(colors.accent);
    expect(labelInk()).toBe(colors.onAccent);
  });

  it('keeps onAccent ink on the solid danger fill, with no outline', async () => {
    await renderButton('danger');

    const surface = buttonSurfaceStyle();
    expect(surface.backgroundColor).toBe(colors.danger);
    expect(surface.borderWidth).toBeUndefined();
    expect(labelInk()).toBe(colors.onAccent);
  });

  it('keeps textPrimary ink on the transparent ghost variant, with no outline', async () => {
    await renderButton('ghost');

    const surface = buttonSurfaceStyle();
    expect(surface.backgroundColor).toBe('transparent');
    expect(surface.borderWidth).toBeUndefined();
    expect(labelInk()).toBe(colors.textPrimary);
  });
});

describe('Button leading glyph', () => {
  it('renders the leading node before the label, together in one row inside the pressable', async () => {
    await renderButton('tinted', <View testID="button-leading" />);

    // One shared row holding the glyph THEN the label, as the pressable's only
    // content: a press on either is a press on the button, and they centre together.
    expect(outline(screen.toJSON())).toBe('View#button(Row(View#button-leading(), Text(Resume)))');
  });

  it('still fires onPress when the press lands on the leading node', async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Button label="Resume" onPress={onPress} testID="button" leading={<View testID="button-leading" />} />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('button-leading'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders the label straight into the pressable, with no row wrapper, when there is no leading node', async () => {
    await renderButton('tinted');

    expect(outline(screen.toJSON())).toBe('View#button(Text(Resume))');
  });
});
