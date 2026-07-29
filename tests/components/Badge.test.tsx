import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ThemeProvider, Badge } from '@/components';

/**
 * These assert the PLUMBING of `align` (does the prop reach `alignSelf`?), not
 * the rendered layout - RNTL does not compute one. The visual guard is
 * /design-pass. What they do lock is the pair of opposite jobs `alignSelf` does
 * for this pill, which is exactly the pair a future edit is likely to conflate.
 */
describe('Badge', () => {
  it('shrink-wraps by default so a Badge in a Stack does not stretch to the container width', () => {
    render(
      <ThemeProvider>
        <Badge label="Deployment target" testID="question-header" />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('question-header').props.style);
    expect(screen.getByText('Deployment target')).toBeTruthy();
    // AskUserQuestionCard puts a Badge straight into a Stack, whose cross axis
    // is horizontal: without this the header pill fills the whole card.
    expect(flattenedStyle.alignSelf).toBe('flex-start');
  });

  it('centers on the cross axis for align="center", so a Badge in a tall Row is not top-pinned', () => {
    render(
      <ThemeProvider>
        <Badge label="M" align="center" testID="changes-file-0-status" />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('changes-file-0-status').props.style);
    expect(flattenedStyle.alignSelf).toBe('center');
  });

  it('keeps the alignment independent of shape and compact', () => {
    render(
      <ThemeProvider>
        <Badge label="7" shape="pill" compact align="center" testID="section-count" />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('section-count').props.style);
    expect(flattenedStyle.alignSelf).toBe('center');
    // `alignItems` centers the pill's own Text and must not be confused with
    // `alignSelf`, which places the pill inside its parent.
    expect(flattenedStyle.alignItems).toBe('center');
  });
});
