import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { BoardTaskQueuePlaceWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { getColumnIcon } from '@/components/board/columnIcons';
import { boardColumnFixture } from '@/devsupport/desktopFixtures';
import { QueuedPanel } from '@/screens/task/QueuedPanel';

/**
 * The reason line's leading glyph (protocol 0.28.0): the lucide Gauge for a
 * global limit, the column's icon in its color for a column limit, a dot in
 * its color when the column has no icon, and nothing without a column. The
 * assertions are on the rendered glyph element and its props (lucide draws an
 * svg host tagged `lucide-<name>` with its color as `stroke`), not on the text.
 */

const COLUMN_PLACE = {
  kind: 'column',
  position: 2,
  total: 3,
  column_name: 'Merge',
  max_agents: 1,
} as BoardTaskQueuePlaceWire;

const GLOBAL_PLACE = {
  kind: 'global',
  position: 1,
  total: 1,
  column_name: null,
  max_agents: 4,
} as BoardTaskQueuePlaceWire;

async function renderPanel(place: BoardTaskQueuePlaceWire, column: Parameters<typeof QueuedPanel>[0]['column']) {
  await render(
    <ThemeProvider>
      <QueuedPanel place={place} column={column} />
    </ThemeProvider>,
  );
}

/** The host children of the reason row, the text excluded: what leads the line. */
function reasonGlyphs() {
  const reasonRow = screen.getByTestId('session-queued-reason');
  return reasonRow.children.flatMap((child) => (typeof child === 'string' || child.type === 'Text' ? [] : [child]));
}

describe('QueuedPanel reason glyph', () => {
  /** Mutation seen failing: columnGlyph's icon branch returned null, so no glyph rendered ahead of the reason text. */
  it('draws the column icon in the column color for a column limit', async () => {
    const column = boardColumnFixture({ icon: 'git-branch', color: '#a371f7' });
    expect(getColumnIcon(column)).not.toBeNull();
    await renderPanel(COLUMN_PLACE, column);

    const glyphs = reasonGlyphs();
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].props.className).toContain('lucide-git-branch');
    expect(glyphs[0].props.stroke).toBe('#a371f7');
    expect(glyphs[0].props.width).toBe(16);
    expect(screen.getByTestId('session-queued-reason')).toHaveTextContent('Merge runs one agent at a time');
  });

  /** Mutation seen failing: columnGlyph's dot branch was dropped, so no 10-point colored View rendered. */
  it('draws a 10-point dot in the column color when the column has no icon', async () => {
    const column = boardColumnFixture({ icon: null, role: null, color: '#f0883e' });
    expect(getColumnIcon(column)).toBeNull();
    await renderPanel(COLUMN_PLACE, column);

    const glyphs = reasonGlyphs();
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].props.className).toBeUndefined();
    expect(StyleSheet.flatten(glyphs[0].props.style)).toMatchObject({
      width: 10,
      height: 10,
      backgroundColor: '#f0883e',
    });
  });

  /** Mutation seen failing: the Gauge in the global branch was replaced with null. */
  it('draws the gauge for a global limit, not the column icon', async () => {
    await renderPanel(GLOBAL_PLACE, boardColumnFixture({ icon: 'git-branch', color: '#a371f7' }));

    const glyphs = reasonGlyphs();
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0].props.className).toContain('lucide-gauge');
    expect(glyphs[0].props.stroke).not.toBe('#a371f7');
    expect(screen.getByTestId('session-queued-reason')).toHaveTextContent('Up to 4 agents run at a time');
  });

  /** Mutation seen failing: the null-column guard was removed, so columnGlyph ran on a missing column and threw. */
  it('draws the reason text with no glyph when there is no column', async () => {
    await renderPanel(COLUMN_PLACE, null);

    expect(screen.getByTestId('session-queued-reason')).toHaveTextContent('Merge runs one agent at a time');
    expect(reasonGlyphs()).toHaveLength(0);
  });
});
