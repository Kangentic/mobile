import React from 'react';
import { View } from 'react-native';
import { Workflow } from 'lucide-react-native';
import { useTheme, type WorkflowSlotPalette } from '@/components';
import { workflowSlotNumber } from '@/workflow/workflowState';

/** A workflow's categorical color, by its (clamped) color slot. */
export function workflowSlotColor(slots: WorkflowSlotPalette, colorSlot: number): string {
  return slots[workflowSlotNumber(colorSlot) - 1] ?? slots[0];
}

/**
 * The workflow's mark: lucide's Workflow glyph in the workflow's own color,
 * the desktop's icon wherever it names a workflow (the card strip at 12, its
 * card menu at 14, its picker at 15). The color is the only thing the slot
 * colors are ever used for.
 */
export function WorkflowGlyph({
  colorSlot,
  size,
  testID,
}: {
  /** Null while the workflow's color is not known yet: the glyph waits in the faint text color. */
  colorSlot: number | null;
  size: number;
  testID?: string;
}): React.JSX.Element {
  const theme = useTheme();
  const color = colorSlot === null ? theme.colors.textMuted : workflowSlotColor(theme.workflowSlots, colorSlot);
  const glyph = <Workflow size={size} color={color} />;
  // The testID rides a wrapping View: lucide forwards `testID` as the web-only
  // `data-testid`, which neither RNTL nor Maestro can select.
  return testID !== undefined ? <View testID={testID}>{glyph}</View> : glyph;
}
