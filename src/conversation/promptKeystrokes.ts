/**
 * The exact keystrokes the phone sends over the interactive-terminal path to
 * answer prompts rendered by the desktop's Claude Code TUI. Deliberately
 * isolated in this one module so a live-desktop verification correction is a
 * one-file change.
 */

/**
 * Approve the pending permission prompt. The desktop repo's own
 * answer-permission-prompt tests drive the TUI with '1\r' (select option 1,
 * confirm), so the phone mirrors that byte-for-byte.
 */
export function approvePermissionKeystrokes(): string {
  return '1\r';
}

/**
 * Deny the pending permission prompt. Esc is the universal reject in Claude
 * Code select prompts; the 'No' option NUMBER varies between dialogs, so a
 * digit would be wrong for some of them. VERIFY against a live desktop,
 * flagged in the plan.
 */
export function denyPermissionKeystrokes(): string {
  return '\x1b';
}

/**
 * Select an AskUserQuestion option by zero-based index. The TUI's digit
 * select covers options 1-9, so only indexes 0..8 are valid.
 *
 * There is deliberately NO permission-dialog equivalent. A permission
 * dialog's option labels reach the phone by screen-scraping the desktop's
 * PTY, and a scraped label is not trustworthy enough to render as a tappable
 * answer - mistaking one numbered option for another approves the wrong
 * thing. The permission card offers Approve, Deny, and "answer in terminal"
 * only; anything else goes through the raw terminal where the user reads the
 * real dialog.
 */
export function askUserQuestionOptionKeystrokes(optionIndex: number): string {
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 8) {
    throw new RangeError(
      `AskUserQuestion option index must be an integer in 0..8, got ${optionIndex}`,
    );
  }
  return String(optionIndex + 1);
}
