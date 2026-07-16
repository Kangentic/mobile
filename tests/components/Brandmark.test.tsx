import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider, Brandmark, darkTerminalTheme } from '@/components';
import {
  brandmarkMonoAmberXml,
  brandmarkMonoXml,
  brandmarkSmallXml,
  brandmarkXml,
} from '@/brand/brandmarkXml.generated';

jest.mock('react-native-svg', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    SvgXml: (props: Record<string, unknown>) => React.createElement(View, props),
  };
});

describe('Brandmark', () => {
  it('defaults to the themed (mono-amber) mark tinted with the primary text color', () => {
    render(
      <ThemeProvider>
        <Brandmark size={28} testID="brandmark" />
      </ThemeProvider>,
    );

    const svgProps = screen.getByTestId('brandmark').props;
    expect(svgProps.xml).toBe(brandmarkMonoAmberXml);
    expect(svgProps.color).toBe(darkTerminalTheme.colors.textPrimary);
    expect(svgProps.width).toBe(28);
    expect(svgProps.height).toBe(28);
  });

  it('renders the pure mono mark for variant mono, honoring a color override', () => {
    render(
      <ThemeProvider>
        <Brandmark size={28} variant="mono" color={darkTerminalTheme.colors.accent} testID="brandmark" />
      </ThemeProvider>,
    );

    const svgProps = screen.getByTestId('brandmark').props;
    expect(svgProps.xml).toBe(brandmarkMonoXml);
    expect(svgProps.color).toBe(darkTerminalTheme.colors.accent);
  });

  it('renders the detailed full-color mark at or above the 64dp tier', () => {
    render(
      <ThemeProvider>
        <Brandmark size={64} variant="full" testID="brandmark" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('brandmark').props.xml).toBe(brandmarkXml);
  });

  it('drops to the simplified small mark below the 64dp tier', () => {
    render(
      <ThemeProvider>
        <Brandmark size={40} variant="full" testID="brandmark" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('brandmark').props.xml).toBe(brandmarkSmallXml);
  });
});
