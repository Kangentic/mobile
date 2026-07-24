/**
 * Byte-sequence constants and helpers for PTY input the phone sends to the
 * desktop's interactive terminal.
 *
 * DECCKM (application cursor mode) is tracked automatically: the WebView's
 * VT parser reports mode flips over the terminal bridge, TerminalPane writes
 * them into terminalUiStore, and QuickKeyBar picks the CSI (`ESC [ A`) or
 * SS3 (`ESC O A`) arrow variant per press via arrowKeySequence.
 */

export const ESCAPE = '\x1b';
export const TAB = '\t';
export const ENTER = '\r';
export const CTRL_C = '\x03';
export const SLASH = '/';

export type ArrowKeyDirection = 'up' | 'down' | 'left' | 'right';

const ARROW_FINAL_BYTES: Record<ArrowKeyDirection, string> = {
  up: 'A',
  down: 'B',
  right: 'C',
  left: 'D',
};

/**
 * The escape sequence for an arrow key press. CSI (`ESC [ A`) by default;
 * SS3 (`ESC O A`) when the terminal is in application cursor mode (DECCKM).
 */
export function arrowKeySequence(
  direction: ArrowKeyDirection,
  applicationCursorMode = false,
): string {
  const finalByte = ARROW_FINAL_BYTES[direction];
  return applicationCursorMode ? `\x1bO${finalByte}` : `\x1b[${finalByte}`;
}
