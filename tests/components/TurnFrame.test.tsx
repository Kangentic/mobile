import React from 'react';
import { render, screen, within } from '@testing-library/react-native';
import { Text, ThemeProvider } from '@/components';
import { TurnFrame } from '@/components/conversation/TurnFrame';
import type { TurnMeta } from '@/conversation/transcriptCells';

function renderTurn(turn: TurnMeta): void {
  render(
    <ThemeProvider>
      <TurnFrame turn={turn}>
        <Text testID="turn-body">body content</Text>
      </TurnFrame>
    </ThemeProvider>,
  );
}

describe('TurnFrame', () => {
  it('renders the "You" badge for a user turn\'s header', () => {
    renderTurn({ role: 'user', position: 'solo', header: { agentName: null, model: null, ts: Date.now() } });

    const badge = screen.getByTestId('turn-role-user');
    expect(within(badge).getByText('You')).toBeTruthy();
    expect(screen.getByTestId('turn-body')).toBeTruthy();
  });

  it('renders the agent\'s name and model for an assistant turn\'s header', () => {
    renderTurn({
      role: 'assistant',
      position: 'solo',
      header: { agentName: 'Claude Code', model: 'claude-fable-5', ts: Date.now() },
    });

    const badge = screen.getByTestId('turn-role-assistant');
    expect(within(badge).getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText('claude-fable-5')).toBeTruthy();
  });

  it('falls back to "Agent" and omits the model text when the header carries neither', () => {
    renderTurn({
      role: 'assistant',
      position: 'solo',
      header: { agentName: null, model: null, ts: Date.now() },
    });

    const badge = screen.getByTestId('turn-role-assistant');
    expect(within(badge).getByText('Agent')).toBeTruthy();
    // 'claude-fable-5' is proven renderable (the previous test asserts it
    // appears when the header carries a model) - its absence here is the
    // conditional actually firing, not just an unused string.
    expect(screen.queryByText('claude-fable-5')).toBeNull();
  });

  it('renders no header row for a middle-position cell (the turn\'s header lives only on its first cell)', () => {
    renderTurn({ role: 'assistant', position: 'middle' });

    expect(screen.queryByTestId('turn-role-assistant')).toBeNull();
    expect(screen.queryByTestId('turn-role-user')).toBeNull();
    expect(screen.getByTestId('turn-body')).toBeTruthy();
  });

  it('labels a just-landed message "just now"', () => {
    renderTurn({ role: 'user', position: 'solo', header: { agentName: null, model: null, ts: Date.now() } });

    expect(screen.getByText('just now')).toBeTruthy();
  });

  it('labels a message from a few minutes ago with the minute count', () => {
    renderTurn({
      role: 'user',
      position: 'solo',
      header: { agentName: null, model: null, ts: Date.now() - 90_000 },
    });

    expect(screen.getByText('1 min ago')).toBeTruthy();
  });
});
