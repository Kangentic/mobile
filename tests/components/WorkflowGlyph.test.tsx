import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { Workflow } from 'lucide-react-native';
import { ThemeProvider } from '@/components';
import { WorkflowGlyph, workflowSlotColor } from '@/components/board/WorkflowGlyph';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { getLucideGlyph } from '../helpers/lucideGlyphs';

/**
 * A workflow's mark takes its color from a 1-based slot on the theme's
 * categorical palette. `workflowSlotNumber` (tests/unit/workflowRules.test.ts)
 * owns the clamp to 1..6; this pins the other half, the mapping of that
 * 1-based number onto the 0-based `workflowSlots` array, and that the glyph
 * inks its stroke with the result.
 *
 * Mutation seen failing: dropping the `- 1` in workflowSlotColor. Slot 1 then
 * reads workflowSlots[1] ("Expected: "#3987e5", Received: "#199e70""), and slot
 * 6 reads past the end of the palette, so it falls back to workflowSlots[0].
 */
const { workflowSlots } = darkTerminalTheme;

describe('workflowSlotColor', () => {
  it('has six distinct slot colors, so an off-by-one in the mapping cannot hide behind a repeat', () => {
    expect(workflowSlots).toHaveLength(6);
    expect(new Set(workflowSlots).size).toBe(6);
  });

  it('maps the 1-based slot onto the palette: slot 1 is the first color and slot 6 the last', () => {
    expect(workflowSlotColor(workflowSlots, 1)).toBe(workflowSlots[0]);
    expect(workflowSlotColor(workflowSlots, 2)).toBe(workflowSlots[1]);
    expect(workflowSlotColor(workflowSlots, 5)).toBe(workflowSlots[4]);
    expect(workflowSlotColor(workflowSlots, 6)).toBe(workflowSlots[5]);
  });

  it('clamps a slot past the palette to the last color', () => {
    expect(workflowSlotColor(workflowSlots, 9)).toBe(workflowSlots[5]);
  });

  it('reads a slot of 0 or NaN as the first color, as the desktop does', () => {
    expect(workflowSlotColor(workflowSlots, 0)).toBe(workflowSlots[0]);
    expect(workflowSlotColor(workflowSlots, Number.NaN)).toBe(workflowSlots[0]);
  });
});

describe('WorkflowGlyph', () => {
  async function renderGlyph(colorSlot: number | null, testID?: string): Promise<void> {
    await render(
      <ThemeProvider>
        <WorkflowGlyph colorSlot={colorSlot} size={12} testID={testID} />
      </ThemeProvider>,
    );
  }

  it("inks the glyph with its workflow's slot color", async () => {
    await renderGlyph(3, 'workflow-glyph');

    expect(getLucideGlyph(screen.getByTestId('workflow-glyph'), Workflow).props.stroke).toBe(workflowSlots[2]);
  });

  it('waits in the faint text color while the slot is not known yet', async () => {
    await renderGlyph(null, 'workflow-glyph');

    expect(getLucideGlyph(screen.getByTestId('workflow-glyph'), Workflow).props.stroke).toBe(darkTerminalTheme.colors.textMuted);
  });
});
