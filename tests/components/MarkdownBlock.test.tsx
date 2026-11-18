import React from 'react';
import { Platform } from 'react-native';
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
  it('renders CommonMark unless a surface asks for the GitHub flavor, and never lets a checkbox toggle', async () => {
    await render(
      <ThemeProvider>
        <MarkdownBlock markdown="- [ ] Main is green." testID="default-markdown" />
        <MarkdownBlock markdown="- [ ] Main is green." flavor="github" testID="github-markdown" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('default-markdown').props.flavor).toBe('commonmark');
    expect(screen.getByTestId('github-markdown').props.flavor).toBe('github');
    // A local toggle would never reach the desktop's description.
    expect(screen.getByTestId('github-markdown').props.enableTaskListItemToggle).toBe(false);
    expect(screen.getByTestId('github-markdown').props.markdownStyle.taskList).toEqual(
      expect.objectContaining({ checkedStrikethrough: false }),
    );
  });

  it('passes the markdown string through to the renderer', async () => {
    await render(
      <ThemeProvider>
        <MarkdownBlock markdown="# Hello **world**" testID="turn-markdown" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('turn-markdown').props.markdown).toBe('# Hello **world**');
    // Real shipped behavior, not probe-only: native text selection on every
    // markdown block by default (the probe only flips it off in a dev build).
    expect(screen.getByTestId('turn-markdown').props.selectable).toBe(true);
  });

  it('derives the markdown styles from theme tokens', async () => {
    await render(
      <ThemeProvider>
        <MarkdownBlock markdown="`inline code`" testID="turn-markdown" />
      </ThemeProvider>,
    );

    const { markdownStyle } = screen.getByTestId('turn-markdown').props;
    expect(markdownStyle.paragraph.fontSize).toBe(14);
    expect(markdownStyle.codeBlock.fontFamily).toBe('monospace');
    expect(markdownStyle.link.color).toBeDefined();
  });

  // enriched-markdown 1.2.0 drew every 600-weight heading at body weight on
  // Android (seen on a release build). A rendered heading cannot be read at
  // this tier, so this pins the mechanism: an empty font family is what keeps
  // the weight off React Native's by-family lookup, which rounds 600 down.
  it('names no font family on an Android heading, so its weight survives', async () => {
    await render(
      <ThemeProvider>
        <MarkdownBlock markdown="## Done when" testID="heading-markdown" />
      </ThemeProvider>,
    );

    const { markdownStyle } = screen.getByTestId('heading-markdown').props;
    const expectedFontFamily = Platform.OS === 'android' ? '' : undefined;
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      expect(markdownStyle[level].fontWeight).toMatch(/^[67]00$/);
      expect(markdownStyle[level].fontFamily).toBe(expectedFontFamily);
    }
  });

  it('keeps the code block header as it was: no line wrap toggle', async () => {
    await render(
      <ThemeProvider>
        <MarkdownBlock markdown={'```ts\nconst ttl = 60;\n```'} flavor="github" testID="code-markdown" />
      </ThemeProvider>,
    );

    // On by default since 1.2.0, and only the GitHub flavor draws it.
    expect(screen.getByTestId('code-markdown').props.enableCodeBlockWrapToggle).toBe(false);
  });
});
