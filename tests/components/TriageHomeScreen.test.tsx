import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TriageHomeScreen } from '@/screens/TriageHomeScreen';

describe('TriageHomeScreen', () => {
  it('renders the three triage sections', () => {
    render(
      <ThemeProvider>
        <TriageHomeScreen />
      </ThemeProvider>,
    );
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
  });
});
