import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider, darkTerminalTheme } from '@/components';
import { ToolCallCard } from '@/components/conversation/ToolCallCard';
import type { ConversationCell, ToolCallResult } from '@/conversation/transcriptCells';

type ToolCallCellModel = Extract<ConversationCell, { kind: 'tool-call' }>;

function makeCell(overrides: Partial<ToolCallCellModel>): ToolCallCellModel {
  return {
    kind: 'tool-call',
    key: 'assist-1:1',
    entryUuid: 'assist-1',
    toolUseId: 'tool-1',
    toolName: 'Bash',
    input: { command: 'npm run lint\nnpm run test:unit' },
    result: null,
    turn: { role: 'assistant', position: 'solo' },
    ...overrides,
  };
}

function renderCard(cell: ToolCallCellModel): void {
  render(
    <ThemeProvider>
      <ToolCallCard cell={cell} />
    </ThemeProvider>,
  );
}

describe('ToolCallCard', () => {
  it('summarizes Bash with the first line of the command', () => {
    renderCard(makeCell({}));
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('npm run lint')).toBeTruthy();
  });

  it('summarizes file tools with the basename and directory', () => {
    renderCard(
      makeCell({
        toolUseId: 'tool-2',
        toolName: 'Read',
        input: { file_path: 'src/screens/task/TaskScreen.tsx' },
      }),
    );
    expect(screen.getByText('TaskScreen.tsx')).toBeTruthy();
    expect(screen.getByText('src/screens/task/')).toBeTruthy();
  });

  it('summarizes Grep with the pattern and Task with the description', () => {
    renderCard(makeCell({ toolUseId: 'tool-3', toolName: 'Grep', input: { pattern: 'FlashList' } }));
    expect(screen.getByText('FlashList')).toBeTruthy();
  });

  it('expands an Edit call to the inline old/new diff', () => {
    renderCard(
      makeCell({
        toolUseId: 'tool-4',
        toolName: 'Edit',
        input: {
          file_path: 'src/a.ts',
          old_string: 'const value = 1;',
          new_string: 'const value = 2;',
        },
      }),
    );
    fireEvent.press(screen.getByTestId('tool-call-tool-4'));
    expect(screen.getByText('-const value = 1;')).toBeTruthy();
    expect(screen.getByText('+const value = 2;')).toBeTruthy();
  });

  it('expands other tools to pretty-printed input JSON', () => {
    renderCard(makeCell({ toolUseId: 'tool-5', toolName: 'WebFetch', input: { url: 'https://example.com' } }));
    fireEvent.press(screen.getByTestId('tool-call-tool-5'));
    expect(screen.getByText(JSON.stringify({ url: 'https://example.com' }, null, 2))).toBeTruthy();
  });

  it('shows a success glyph and a collapsed result preview', () => {
    const result: ToolCallResult = { content: 'lint passed', isError: false };
    renderCard(makeCell({ result }));
    expect(screen.getByText('✓')).toBeTruthy();
    expect(screen.getByText('lint passed')).toBeTruthy();
  });

  it('tints an error result with the danger border and glyph', () => {
    const result: ToolCallResult = { content: 'command failed\nstack line', isError: true };
    renderCard(makeCell({ result }));
    expect(screen.getByText('✗')).toBeTruthy();
    const resultBlock = screen.getByTestId('tool-result-tool-1');
    expect(StyleSheet.flatten(resultBlock.props.style).borderLeftColor).toBe(darkTerminalTheme.colors.danger);
  });

  it('expands the result to its full content on tap', () => {
    const result: ToolCallResult = { content: 'line one\nline two\nline three', isError: false };
    renderCard(makeCell({ result }));
    fireEvent.press(screen.getByTestId('tool-result-tool-1'));
    expect(screen.getByText('line one\nline two\nline three')).toBeTruthy();
  });

  // The tools below dominate a real Claude Code session and all previously fell
  // through to a bare glyph with an EMPTY summary column, because the mock only
  // ever produced Edit and Bash so nothing exercised them.
  it('summarizes TodoWrite with its progress and the active item', () => {
    renderCard(
      makeCell({
        toolUseId: 'tool-todo',
        toolName: 'TodoWrite',
        input: {
          todos: [
            { content: 'Thread the path through', status: 'completed', activeForm: 'Threading the path through' },
            { content: 'Reject off-site paths', status: 'in_progress', activeForm: 'Rejecting off-site paths' },
            { content: 'Update the call sites', status: 'pending', activeForm: 'Updating the call sites' },
          ],
        },
      }),
    );
    expect(screen.getByText('TodoWrite')).toBeTruthy();
    expect(screen.getByText('1 of 3 done - Reject off-site paths')).toBeTruthy();
  });

  it('reads an MCP tool as its server plus the tool it called', () => {
    renderCard(
      makeCell({
        toolUseId: 'tool-mcp',
        toolName: 'mcp__github__list_pull_requests',
        input: { owner: 'storefront', repo: 'storefront-web' },
      }),
    );
    // The raw `mcp__github__list_pull_requests` reads as a symbol, not an action.
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('list_pull_requests')).toBeTruthy();
  });

  it('bounds the JSON fallback so a large input cannot run off the row', () => {
    renderCard(
      makeCell({
        toolUseId: 'tool-todo-expand',
        toolName: 'TodoWrite',
        input: { todos: Array.from({ length: 40 }, (_, index) => ({ content: `item ${index}`, status: 'pending' })) },
      }),
    );
    fireEvent.press(screen.getByTestId('tool-call-tool-todo-expand'));
    // A MonoBlock given a maxHeight renders a nested-scrollable ScrollView
    // capped at that height; without one it is a plain View that grows without
    // limit inside a FlashList row.
    const scrollables = screen.UNSAFE_getAllByProps({ nestedScrollEnabled: true });
    expect(scrollables.length).toBeGreaterThan(0);
    expect(StyleSheet.flatten(scrollables[0].props.style).maxHeight).toBe(300);
  });
});
