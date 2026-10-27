import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider, MarkdownBlock } from '@/components';

// The library's OWN jest mock, not the View passthrough MarkdownBlock.test.tsx
// uses: it turns `[text](url)` into a `link`-role Text that calls `onLinkPress`
// on press, and leaves the link as inert source text when no handler is passed.
// That last part mirrors the device bug (the native view never opens a URL
// itself), which is why this lives in its own file: jest.mock is per-file, and
// the passthrough suite asserts on props this mock drops.
jest.mock('react-native-enriched-markdown', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-enriched-markdown/jest'),
);

const mockOpenURL = jest.fn().mockResolvedValue(true);
jest.mock('expo-linking', () => ({
  openURL: (url: string) => mockOpenURL(url),
}));

async function renderMarkdown(markdown: string): Promise<void> {
  await render(
    <ThemeProvider>
      <MarkdownBlock markdown={markdown} testID="turn-markdown" />
    </ThemeProvider>,
  );
}

describe('MarkdownBlock links', () => {
  beforeEach(() => {
    mockOpenURL.mockReset().mockResolvedValue(true);
  });

  /**
   * The reported bug: a link rendered styled but a tap did nothing, because
   * the adapter passed no `onLinkPress` and the library opens nothing itself.
   */
  it('opens a tapped https link in the OS handler', async () => {
    await renderMarkdown('Merged (see [the PR](https://github.com/Kangentic/kangentic/pull/656)).');

    await fireEvent.press(screen.getByRole('link', { name: 'the PR' }));

    expect(mockOpenURL).toHaveBeenCalledTimes(1);
    expect(mockOpenURL).toHaveBeenCalledWith('https://github.com/Kangentic/kangentic/pull/656');
  });

  it('reads the scheme case-insensitively', async () => {
    await renderMarkdown('[shouting](HTTPS://github.com/Kangentic/kangentic/pull/656)');

    await fireEvent.press(screen.getByRole('link', { name: 'shouting' }));

    expect(mockOpenURL).toHaveBeenCalledWith('HTTPS://github.com/Kangentic/kangentic/pull/656');
  });

  /**
   * Link URLs are agent-authored. The app's own schemes would loop a
   * transcript link back into the deep-link router, and the rest have no
   * business reaching the OS opener at all.
   */
  it.each([
    ['the pairing deep link', 'kangentic-pair://demo'],
    ['the app scheme', 'kangentic://task/123'],
    ['javascript', 'javascript:void0'],
    ['a local file', 'file:///etc/hosts'],
    ['plain http', 'http://github.com/Kangentic/kangentic/pull/656'],
  ])('ignores a tapped link to %s', async (_description, url) => {
    await renderMarkdown(`[tap me](${url})`);

    await fireEvent.press(screen.getByRole('link', { name: 'tap me' }));

    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it('swallows an OS refusal rather than leaving it unhandled', async () => {
    mockOpenURL.mockRejectedValueOnce(new Error('No activity found to handle Intent'));
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await renderMarkdown('[the PR](https://github.com/Kangentic/kangentic/pull/656)');

      await fireEvent.press(screen.getByRole('link', { name: 'the PR' }));
      await act(async () => {});

      expect(mockOpenURL).toHaveBeenCalledTimes(1);
      // The catch ran: a dropped `.catch` would leave the rejection unhandled
      // and this dev-only warning unlogged.
      expect(warnSpy).toHaveBeenCalledWith('[markdown] could not open link:', expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
