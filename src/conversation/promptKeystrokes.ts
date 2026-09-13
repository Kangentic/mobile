/**
 * The exact keystrokes the phone sends to answer prompts rendered by the
 * desktop's Claude Code TUI. They travel as the `answer-permission-prompt`
 * verb, NOT `interactive-terminal`: the desktop binds the answer to a specific
 * live promptId and rejects a stale or already-resolved one (see the desktop's
 * `handlers/answer-permission-prompt.ts`). Deliberately isolated in this one
 * module so a live-desktop verification correction is a one-file change.
 *
 * ALL THREE CONSTANTS WERE VERIFIED ON A PIXEL AGAINST A LIVE DESKTOP,
 * 2026-09-13. Nothing needed changing. Details on task #7; summary below.
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
 * digit would be wrong for some of them.
 *
 * VERIFIED on a Pixel against a live desktop, 2026-09-13, across the two
 * dialog variants where the option numbering differs:
 *
 *   Write dialog -> `⎿ User rejected write to <file>`, and the file was
 *     absent on disk afterwards.
 *   Bash dialog  -> `⎿ Interrupted · What should Claude do instead?`, and the
 *     command never ran.
 *
 * Both left a `tool_start` with no matching `tool_end` in the session's
 * events.jsonl, and both rendered in the phone's own transcript as `✗ <tool>`
 * with "The user doesn't want to proceed with this tool use". The control
 * matters as much as the result: tapping Approve on an identical prompt on the
 * same rig DID create the file, so the absence is the deny, not a dead button.
 */
export function denyPermissionKeystrokes(): string {
  return '\x1b';
}

/**
 * Select an AskUserQuestion option by zero-based index. The TUI's digit
 * select covers options 1-9, so only indexes 0..8 are valid.
 *
 * VERIFIED on a Pixel against a live desktop, 2026-09-13, with a real
 * four-option AskUserQuestion (four so an off-by-one in EITHER direction is
 * visible). Tapping the third option sent `'3'` and the desktop recorded
 * `→ charlie-three`, the exact label the phone had rendered. So the TUI
 * accepts a bare digit with no CR - the asymmetry against approve's `'1\r'`
 * is real and fine - and the index-to-digit mapping is correct.
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
