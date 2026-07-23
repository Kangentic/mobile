/**
 * How many of a task's labels fit on one row before an overflow "+N" pill
 * is needed, estimated from character count rather than an actual text
 * measurement pass - cheap enough to run per card in a scrolling FlashList,
 * and conservative (slightly overestimates each pill's width) so it never
 * predicts more than genuinely fits.
 */

/** Rough average glyph width for the label pill's 12px proportional caption text. */
const AVG_CHAR_WIDTH_PX = 7;
/** Badge rect shape: `theme.spacing.sm` (8) horizontal padding on both sides, plus its hairline border. */
const BADGE_CHROME_PX = 18;
/** `Row gap="sm"` between adjacent pills. */
const ROW_GAP_PX = 8;

function estimateBadgeWidth(label: string): number {
  return label.length * AVG_CHAR_WIDTH_PX + BADGE_CHROME_PX;
}

/**
 * Greedily fits as many labels as possible into `availableWidth`, reserving
 * room for the "+N" overflow pill whenever not everything fits. Returns the
 * count to actually render (the rest become the overflow count).
 */
export function computeVisibleLabelCount(labels: string[], availableWidth: number): number {
  if (labels.length === 0) return 0;

  const fullWidth = labels.reduce(
    (sum, label, index) => sum + estimateBadgeWidth(label) + (index > 0 ? ROW_GAP_PX : 0),
    0,
  );
  if (fullWidth <= availableWidth) return labels.length;

  // Not everything fits - an overflow pill will render too, so its width
  // (plus the gap before it) has to stay reserved throughout the greedy fit.
  // "+99" is a safe upper bound for the overflow pill's own text width.
  const overflowBadgeWidth = estimateBadgeWidth('+99');

  let usedWidth = 0;
  let visibleCount = 0;
  for (const label of labels) {
    const labelWidth = estimateBadgeWidth(label) + (visibleCount > 0 ? ROW_GAP_PX : 0);
    const widthIfShown = usedWidth + labelWidth;
    if (widthIfShown + ROW_GAP_PX + overflowBadgeWidth > availableWidth) break;
    usedWidth = widthIfShown;
    visibleCount++;
  }
  return visibleCount;
}
