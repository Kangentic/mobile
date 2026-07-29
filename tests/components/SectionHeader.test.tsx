import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ThemeProvider, SectionHeader } from '@/components';

/**
 * The count pill is deliberately given no testID: it is not interactive (see
 * .claude/rules/ui-conventions.md), and any id derived from the header's own
 * would be a SUPERSTRING of the `section-header-idle` / `-thinking` selectors
 * three paired Maestro flows tap, whose id matching is regex-based. So the
 * pill is reached through its label text and the Badge View is its parent.
 */
function countPillAlignSelf(headerTestID: string, countLabel: string): string | undefined {
  let ancestor = within(screen.getByTestId(headerTestID)).getByText(countLabel).parent;
  // RNTL's parent chain includes composite wrappers (the RN Text class and our
  // own Text), so a fixed hop count would break on any refactor. Badge's root
  // View is the only node in this subtree that sets alignSelf at all.
  while (ancestor !== null) {
    const flattenedStyle = StyleSheet.flatten(ancestor.props.style);
    if (flattenedStyle?.alignSelf !== undefined) {
      return flattenedStyle.alignSelf;
    }
    ancestor = ancestor.parent;
  }
  return undefined;
}

describe('SectionHeader', () => {
  describe('collapsible variant (count + collapsed + onToggle)', () => {
    it('renders the title and the count badge, and fires onToggle when pressed', () => {
      const onToggle = jest.fn();
      render(
        <ThemeProvider>
          <SectionHeader title="Idle" count={4} collapsed={false} onToggle={onToggle} testID="section-idle" />
        </ThemeProvider>,
      );

      expect(screen.getByText('Idle')).toBeTruthy();
      expect(within(screen.getByTestId('section-idle')).getByText('4')).toBeTruthy();

      fireEvent.press(screen.getByTestId('section-idle'));

      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    // THE REGRESSION GUARD: SectionHeader passes align="center" to the count
    // Badge because Badge's own default alignSelf: 'flex-start' overrides the
    // Row's alignItems: 'center' (see Badge.tsx's `align` prop doc). Without
    // it the compact pill (about 19pt) sits at the top of the row the 24pt
    // title defines, floating above the title it labels.
    it('centers the count badge on the row cross axis', () => {
      render(
        <ThemeProvider>
          <SectionHeader title="Idle" count={4} collapsed={false} onToggle={jest.fn()} testID="section-idle" />
        </ThemeProvider>,
      );

      expect(countPillAlignSelf('section-idle', '4')).toBe('center');
    });

    it('sets accessibilityState.expanded and the accessibilityLabel for the expanded state', () => {
      render(
        <ThemeProvider>
          <SectionHeader title="Idle" count={4} collapsed={false} onToggle={jest.fn()} testID="section-idle" />
        </ThemeProvider>,
      );

      const header = screen.getByTestId('section-idle');
      expect(header.props.accessibilityState).toEqual({ expanded: true });
      expect(header.props.accessibilityLabel).toBe('Idle, 4, expanded');
    });

    it('sets accessibilityState.expanded and the accessibilityLabel for the collapsed state', () => {
      render(
        <ThemeProvider>
          <SectionHeader title="Thinking" count={2} collapsed onToggle={jest.fn()} testID="section-thinking" />
        </ThemeProvider>,
      );

      const header = screen.getByTestId('section-thinking');
      expect(header.props.accessibilityState).toEqual({ expanded: false });
      expect(header.props.accessibilityLabel).toBe('Thinking, 2, collapsed');
    });

    it('falls back to a 0 count in the accessibilityLabel when count is omitted', () => {
      render(
        <ThemeProvider>
          <SectionHeader title="Idle" collapsed={false} onToggle={jest.fn()} testID="section-idle" />
        </ThemeProvider>,
      );

      // The label carries the 0; no pill renders, so nothing draws it on screen.
      expect(screen.getByTestId('section-idle').props.accessibilityLabel).toBe('Idle, 0, expanded');
      expect(screen.queryByText('0')).toBeNull();
    });
  });

  describe('plain variant (no onToggle)', () => {
    it('renders only the title, with no count badge and no press handling', () => {
      render(
        <ThemeProvider>
          <SectionHeader title="Settings" testID="section-settings" />
        </ThemeProvider>,
      );

      expect(screen.getByText('Settings')).toBeTruthy();

      const header = screen.getByTestId('section-settings');
      expect(header.props.accessibilityRole).toBeUndefined();
      expect(header.props.onPress).toBeUndefined();
    });

    it('ignores a count prop when onToggle is not provided', () => {
      render(
        <ThemeProvider>
          <SectionHeader title="Settings" count={9} testID="section-settings" />
        </ThemeProvider>,
      );

      expect(screen.queryByText('9')).toBeNull();
    });
  });
});
