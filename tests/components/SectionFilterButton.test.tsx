import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { ListFilter } from 'lucide-react-native';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { SectionFilterButton } from '@/screens/home/SectionFilterButton';
import { useSettingsStore } from '@/state/settingsStore';
import { getLucideGlyph } from '../helpers/lucideGlyphs';

/**
 * The Agents header's section filter. TriageHomeScreen.test.tsx pins its dot,
 * its label and its press through the whole screen; this pins what that suite
 * does not: the glyph's INK. The button turns accent while any section is hidden
 * (the dot alone is an 8 dp mark on the circle's edge), and it moved from a bare
 * Icon into IconButton's `iconColor`, so the choice of role is this component's
 * and the passthrough is IconButton's.
 *
 * Mutation seen failing: pinning `iconColor="secondary"` ("Expected: "#e8a33d",
 * Received: "#b5a892"" with a section hidden).
 */
const { colors } = darkTerminalTheme;

// The press (it pushes /section-filter) is TriageHomeScreen.test.tsx's.
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

async function renderButton(): Promise<void> {
  await render(
    <ThemeProvider>
      <SectionFilterButton />
    </ThemeProvider>,
  );
}

function glyphInk(): unknown {
  return getLucideGlyph(screen.getByTestId('header-section-filter-button'), ListFilter).props.stroke;
}

describe('SectionFilterButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSettingsStore.setState({ hiddenTriageSections: [] });
  });

  it('inks the glyph secondary while every section is shown', async () => {
    await renderButton();

    expect(glyphInk()).toBe(colors.textSecondary);
  });

  it('inks the glyph accent while any section is hidden', async () => {
    useSettingsStore.setState({ hiddenTriageSections: ['Paused'] });
    await renderButton();

    expect(glyphInk()).toBe(colors.accent);
  });

  it('turns accent as soon as a section is hidden under the mounted button, and back when all are shown', async () => {
    await renderButton();
    expect(glyphInk()).toBe(colors.textSecondary);

    await act(() => {
      useSettingsStore.setState({ hiddenTriageSections: ['Paused', 'Queued'] });
    });
    expect(glyphInk()).toBe(colors.accent);

    await act(() => {
      useSettingsStore.setState({ hiddenTriageSections: [] });
    });
    expect(glyphInk()).toBe(colors.textSecondary);
  });
});
