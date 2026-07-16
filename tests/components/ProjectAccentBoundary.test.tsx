import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import type { ReadBoardProjectSummary } from '@kangentic/protocol';
import { darkTerminalTheme, ProjectAccentBoundary, Text, ThemeProvider, useTheme } from '@/components';
import { useBoardStore } from '@/state/boardStore';

/** Renders the accent family the nested theme resolves to, for assertion. */
function AccentProbe(): React.JSX.Element {
  const theme = useTheme();
  return (
    <>
      <Text testID="probe-accent">{theme.colors.accent}</Text>
      <Text testID="probe-on-accent">{theme.colors.onAccent}</Text>
      <Text testID="probe-needs-you">{theme.colors.statusNeedsYou}</Text>
    </>
  );
}

function renderBoundary(projectId: string | null | undefined): void {
  render(
    <ThemeProvider>
      <ProjectAccentBoundary projectId={projectId}>
        <AccentProbe />
      </ProjectAccentBoundary>
    </ThemeProvider>,
  );
}

function probeText(testID: string): string {
  const probeElement = screen.getByTestId(testID);
  return String(probeElement.props.children);
}

describe('ProjectAccentBoundary', () => {
  afterEach(() => {
    act(() => useBoardStore.getState().reset());
  });

  it('overrides the accent family for a project that carries a color', () => {
    const coloredProject: ReadBoardProjectSummary & { color: string } = {
      id: 'project-colored',
      name: 'Colored',
      color: '#5da9e0',
    };
    act(() => useBoardStore.setState({ projects: [coloredProject] }));

    renderBoundary('project-colored');

    expect(probeText('probe-accent')).toBe('#5da9e0');
    // Brand ink stays readable (>= 4.5:1) on this light blue, so ink wins.
    expect(probeText('probe-on-accent')).toBe(darkTerminalTheme.brand.ink);
    // Non-accent tokens never vary per project.
    expect(probeText('probe-needs-you')).toBe(darkTerminalTheme.colors.statusNeedsYou);
  });

  it('picks cream for onAccent when ink cannot read on the resolved accent', () => {
    const midBlueProject: ReadBoardProjectSummary & { color: string } = {
      id: 'project-mid-blue',
      name: 'MidBlue',
      color: '#3d6ae0',
    };
    act(() => useBoardStore.setState({ projects: [midBlueProject] }));

    renderBoundary('project-mid-blue');

    expect(probeText('probe-accent')).toBe('#3d6ae0');
    expect(probeText('probe-on-accent')).toBe(darkTerminalTheme.brand.cream);
  });

  it('passes the base theme through when the project has no color field', () => {
    const plainProject: ReadBoardProjectSummary = { id: 'project-plain', name: 'Plain' };
    act(() => useBoardStore.setState({ projects: [plainProject] }));

    renderBoundary('project-plain');

    expect(probeText('probe-accent')).toBe(darkTerminalTheme.colors.accent);
    expect(probeText('probe-on-accent')).toBe(darkTerminalTheme.colors.onAccent);
  });

  it('passes the base theme through for a missing projectId', () => {
    renderBoundary(null);
    expect(probeText('probe-accent')).toBe(darkTerminalTheme.colors.accent);
  });

  it('passes the base theme through when the wire color is unusable', () => {
    const garbageColorProject: ReadBoardProjectSummary & { color: string } = {
      id: 'project-garbage',
      name: 'Garbage',
      color: 'chartreuse',
    };
    act(() => useBoardStore.setState({ projects: [garbageColorProject] }));

    renderBoundary('project-garbage');

    expect(probeText('probe-accent')).toBe(darkTerminalTheme.colors.accent);
  });
});
