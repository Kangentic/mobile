import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider, MarkdownBlock } from '@/components';

// EnrichedMarkdownText is a native Fabric component, so the adapter's library
// boundary is mocked with a plain View passthrough; the test asserts the
// adapter hands the markdown string and themed styles across that boundary.
jest.mock('react-native-enriched-markdown', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    EnrichedMarkdownText: (props: object) => ReactModule.createElement(View, props),
  };
});

describe('MarkdownBlock', () => {
  it('passes the markdown string through to the renderer', () => {
    render(
      <ThemeProvider>
        <MarkdownBlock markdown="# Hello **world**" testID="turn-markdown" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('turn-markdown').props.markdown).toBe('# Hello **world**');
    // Real shipped behavior, not probe-only: native text selection on every
    // markdown block by default (the probe only flips it off in a dev build).
    expect(screen.getByTestId('turn-markdown').props.selectable).toBe(true);
  });

  it('derives the markdown styles from theme tokens', () => {
    render(
      <ThemeProvider>
        <MarkdownBlock markdown="`inline code`" testID="turn-markdown" />
      </ThemeProvider>,
    );

    const { markdownStyle } = screen.getByTestId('turn-markdown').props;
    expect(markdownStyle.paragraph.fontSize).toBe(14);
    expect(markdownStyle.codeBlock.fontFamily).toBe('monospace');
    expect(markdownStyle.link.color).toBeDefined();
  });
});
