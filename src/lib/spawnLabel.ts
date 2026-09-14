/**
 * The desktop's in-flight spawn-progress label (kangentic board #639) is
 * untrusted DISPLAY TEXT, and three surfaces now render it: the session
 * screen's switching overlay, the Home feed row, and the board card. The
 * sanitizer lives here so those three cannot drift - in particular so none of
 * them re-derives the `typeof`-adjacent guard and calls `.trim()` on something
 * that is not a string.
 */

/**
 * The budget from ui-copy-brevity.md's "descriptions are one line at default
 * font on a small phone (~45 characters)". All four known desktop phase
 * labels ("Switching model...", "Switching agent...", "Applying new
 * settings...", "Starting new session...") fit well under it.
 *
 * A character count is a guard against a wall of text, NOT a guarantee of one
 * rendered line: at a large accessibility font scale a 45-character caption
 * wraps whatever this says. That is harmless on the overlay (the caption is
 * centered with nothing below it, so it grows rather than clipping) and the
 * card clamps its own body with `numberOfLines`. Do not lean on this cap as a
 * scaling-safe mechanism elsewhere.
 */
const MAX_LABEL_LENGTH = 45;

/**
 * Every code point React Native's `<Text>` breaks a line on. U+2028 (LINE
 * SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are easy to miss: `trim()`
 * counts them as line terminators and so strips them at the ENDS, which
 * makes an INTERIOR one clear every other check below and render a two-line
 * caption from a string that passed a one-line shape test.
 *
 * Code points rather than a regex literal on purpose: written inline, U+2028
 * and U+2029 terminate the literal itself, so the guard against them cannot
 * safely be spelled with them.
 */
const LINE_BREAKING_CODE_POINTS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

function hasLineBreak(value: string): boolean {
  for (const character of value) {
    if (LINE_BREAKING_CODE_POINTS.has(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * Whether `label` is safe to render as-is. The label can carry a decorated
 * staleness note or a git-queue wait string, so this is a length and shape
 * check, never a lookup against known values.
 *
 * Falls back rather than truncates: a chopped "Applying new sett..." reads
 * worse than the honest generic caption each caller supplies. Empty-string
 * rejection mirrors activityStore's messagePreview convention - never let ""
 * mean "nothing to say".
 */
export function renderableSpawnLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  if (hasLineBreak(trimmed)) return null;
  if (trimmed.length > MAX_LABEL_LENGTH) return null;
  return trimmed;
}
