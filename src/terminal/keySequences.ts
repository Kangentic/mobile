/**
 * Byte-sequence constants and helpers for PTY input the phone sends to the
 * desktop's interactive terminal.
 *
 * v1 always sends the CSI arrow variants (`ESC [ A` etc.). Claude Code's TUI
 * accepts these in normal cursor mode. Tracking DECCKM (application cursor
 * mode, which expects the SS3 variants `ESC O A` etc.) from the PTY output
 * stream is a possible later change - VERIFY against real Claude Code,
 * flagged in the plan.
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
