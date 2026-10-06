import type { TextColorRole } from '../Text';

/**
 * How a task's linked PR renders on the card, and how it reads out loud.
 *
 * Desktop parity, with one deliberate shape change. The desktop card gives the
 * PR its own row: a labeled link with a state badge (`open` / `draft` /
 * `merged` / `closed`, or the merge verdict). The phone has one title row,
 * shared with the status icon and the ticket number, so the chip there is an
 * ICON ONLY and never spends title width on a word. The design review
 * (2026-10-05) compared that against a pill that grew a word for a verdict,
 * and against a muted icon with a colored dot, and chose the icon. So the
 * icon carries the state by its SHAPE, and the verdict by its COLOR:
 *
 * - Shape: a pull request (open), a merge (merged), a crossed-out pull request
 *   (closed), a dashed one (draft), and a merge conflict.
 * - Color, while open: green is `ready` - the promise "a merge would land
 *   now" - and so plain open, with no verdict, drops to the quiet secondary
 *   text color. That is the one change from the old chip, where open and
 *   ready were the same green and only the word told them apart.
 *
 * The state/readiness mapping itself is the desktop's, from its
 * `renderer/lib/pr-state.ts`:
 *
 * - Readiness is consulted ONLY while the PR is open. A stale verdict on a
 *   merged PR must never show through, which is why the non-open branches
 *   ignore it rather than falling through to a shared lookup.
 * - `conflicting` is rust rather than red, so it never reads as `closed`, and
 *   its word is `conflicts` - NOT the wire value.
 * - `queued` / `running` mean a blocking check is still in flight, so they take
 *   a hue that is neither a pass nor a fail.
 * - `unknown`, null, an absent field, and any value this client does not
 *   recognise render as plain open. That last one is the protocol's own
 *   instruction, and it is what keeps a desktop that grows a seventh verdict
 *   from blanking the chip here.
 *
 * The verdict's word survives where there is room for it: the long-press menu
 * caption (`prStateSummary`) and the spoken label (`prChipAccessibilityLabel`).
 *
 * Neither parameter narrows to a union, because `@kangentic/protocol` exports no
 * readiness union to narrow against (see
 * `.claude/rules/protocol-types-from-package.md`: a local parallel type would
 * drift from the desktop's, which is the failure this module must not have).
 */
export interface PrChipPresentation {
  /** Which PR glyph to draw. A presentation name, mapped to a lucide icon by the card. */
  glyph: PrChipGlyph;
  color: TextColorRole;
}

/** The PR glyphs the chip draws: one shape per state, plus the conflict shape for an open PR that has one. */
export type PrChipGlyph = 'pull-request' | 'merge' | 'merge-conflict' | 'closed' | 'draft';

/**
 * The freshness caveat every spoken verdict carries. Exported so the tests
 * assert against the string the module actually ships rather than re-typing
 * it: a copy-edit here must not need a hand-synchronised edit in two test
 * files to stay honest.
 */
export const PR_READINESS_FRESHNESS_CAVEAT = 'as of the last PR refresh';

/** A recognised verdict: an icon and color for the chip, one word for the menu, one sentence for a reader. */
interface ReadinessPresentation {
  /**
   * Nested rather than spread alongside `word` and `spokenDetail`, so
   * `prChipPresentation` can hand this straight back without widening its
   * documented return shape: the chip contract is exactly `{ glyph, color }`,
   * and a third key leaking into it would be invisible to `tsc` but visible to
   * every caller.
   */
  chip: PrChipPresentation;
  /** The verdict in one word, for a surface with room to say it (the long-press menu caption). */
  word: string;
  /** The spoken form, minus the caveat, which is appended at the one call site. */
  spokenDetail: string;
}

/**
 * The readiness verdicts that change the chip, and the ONE table all three
 * exported functions read. A verdict added here gets its chip, its summary word
 * and its spoken form together or not at all, which is the drift this module
 * cannot afford: a chip colored for `blocked` while a screen reader says
 * `open` describes the same PR two ways.
 *
 * A `Map`, deliberately, not an object literal. An object literal inherits
 * `Object.prototype`, so a wire value that happens to name a member of it
 * (`constructor`, `toString`, `valueOf`, `__proto__`) would HIT the lookup and
 * return a function in place of a presentation - the `?? PLAIN_OPEN` fallback
 * never fires, and the card renders a chip with an undefined glyph and an
 * undefined color. `Map.get` misses cleanly for those keys. This is not
 * hypothetical robustness: the protocol states that a value a client does not
 * know renders as plain open (see `BoardTaskWire.pr_merge_readiness`), and an
 * object literal cannot honour that for every string the wire can carry.
 * `Map.get` also returns `T | undefined`, so the fallback is live code to
 * `tsc` rather than the dead branch an unchecked index signature makes it.
 */
const READINESS_PRESENTATION: ReadonlyMap<string, ReadinessPresentation> = new Map([
  [
    'ready',
    {
      chip: { glyph: 'pull-request', color: 'success' },
      word: 'ready',
      spokenDetail: 'Pull request ready to merge',
    },
  ],
  [
    'blocked',
    {
      chip: { glyph: 'pull-request', color: 'warning' },
      word: 'blocked',
      spokenDetail: 'Pull request merge blocked by reviews, checks, or branch rules',
    },
  ],
  [
    'conflicting',
    {
      chip: { glyph: 'merge-conflict', color: 'conflict' },
      word: 'conflicts',
      spokenDetail: 'Pull request has merge conflicts with the base branch',
    },
  ],
  [
    'queued',
    {
      chip: { glyph: 'pull-request', color: 'info' },
      word: 'queued',
      spokenDetail: 'Pull request checks or policies are queued',
    },
  ],
  [
    'running',
    {
      chip: { glyph: 'pull-request', color: 'info' },
      word: 'running',
      spokenDetail: 'Pull request checks or policies are running',
    },
  ],
] satisfies readonly (readonly [string, ReadinessPresentation])[]);

/**
 * Every verdict this client recognises, derived from the table rather than
 * retyped. The tests iterate THIS, so a verdict added to the table above is
 * automatically held to all three functions' contracts instead of passing a
 * suite whose expectations were hand-copied and never extended.
 */
export const PR_READINESS_VERDICTS: readonly string[] = Array.from(READINESS_PRESENTATION.keys());

/**
 * Plain `open`, and the resting appearance for anything without a verdict:
 * the quiet secondary text color, so that green can mean `ready` alone.
 */
const PLAIN_OPEN: PrChipPresentation = { glyph: 'pull-request', color: 'secondary' };

/** Hoisted for the same reason `PLAIN_OPEN` is: a recycled board row renders these on every pass. */
const MERGED_PRESENTATION: PrChipPresentation = { glyph: 'merge', color: 'info' };
const CLOSED_PRESENTATION: PrChipPresentation = { glyph: 'closed', color: 'danger' };
const DRAFT_PRESENTATION: PrChipPresentation = { glyph: 'draft', color: 'muted' };

/**
 * The one place the wire's three-state readiness becomes a table lookup.
 *
 * `BoardTaskWire.pr_merge_readiness` is OPTIONAL since protocol 0.13.1, so a
 * desktop may omit the field entirely. Absent (`undefined`) and
 * present-but-never-judged (`null`) mean the same thing here - no verdict - and
 * collapsing them once keeps all three exported functions total for the wire
 * type instead of each restating the distinction.
 *
 * Returns `undefined` for a miss as well as for no verdict, which is what lets
 * the chip and summary readers spell the fallback as a single `??`, and lets
 * the spoken reader branch once on absence instead of twice.
 *
 * Named for what it returns rather than as the camelCase of
 * `READINESS_PRESENTATION`: it is not an accessor for that table, it is the
 * guard in front of it.
 */
function presentationForReadiness(
  prMergeReadiness: string | null | undefined,
): ReadinessPresentation | undefined {
  if (prMergeReadiness === null || prMergeReadiness === undefined) return undefined;
  return READINESS_PRESENTATION.get(prMergeReadiness);
}

export function prChipPresentation(
  prState: string | null,
  prMergeReadiness: string | null | undefined,
): PrChipPresentation {
  switch (prState) {
    case 'open':
      return presentationForReadiness(prMergeReadiness)?.chip ?? PLAIN_OPEN;
    case 'merged':
      return MERGED_PRESENTATION;
    case 'closed':
      return CLOSED_PRESENTATION;
    case 'draft':
      return DRAFT_PRESENTATION;
    // `null`, and anything unrecognised.
    default:
      return PLAIN_OPEN;
  }
}

/**
 * The PR's state as one always-present word, for a surface with room to say it
 * (the chip itself never does). Its one caller today is the long-press menu's
 * caption (`TaskActionsScreen`).
 *
 * Reads `READINESS_PRESENTATION` rather than keeping its own mapping, which is
 * what stops the menu and the card describing the same PR differently.
 * `prChipAccessibilityLabel` reads that same table directly rather than going
 * through here, so the three stay consistent by sharing a source, not by
 * calling each other.
 */
export function prStateSummary(
  prState: string | null,
  prMergeReadiness: string | null | undefined,
): string {
  if (prState === 'open') {
    return presentationForReadiness(prMergeReadiness)?.word ?? 'open';
  }
  if (prState === 'draft' || prState === 'merged' || prState === 'closed') return prState;
  return 'open';
}

/**
 * What a screen reader says for the chip. The desktop hangs this on a `title`
 * tooltip; touch has no hover and `.claude/rules/ui-conventions.md` bans
 * hover-only affordances, so the accessibility label is the only place the
 * freshness caveat can be stated at all. Accessibility labels are exempt from
 * `.claude/rules/ui-copy-brevity.md`, so this stays fully descriptive.
 *
 * The caveat is not boilerplate: the verdict is only as fresh as the desktop's
 * last PR refresh, and it is resolved from that desktop's own viewpoint, so
 * presenting it as live truth would overpromise.
 *
 * Reads `READINESS_PRESENTATION` rather than keeping a parallel switch, so a
 * verdict added to that table cannot color the visible chip while falling
 * through to a spoken "open" here.
 */
export function prChipAccessibilityLabel(
  prState: string | null,
  prMergeReadiness: string | null | undefined,
): string {
  if (prState === 'open') {
    const readiness = presentationForReadiness(prMergeReadiness);
    // No verdict, or one this client does not know: there is nothing to be
    // stale about, so the caveat would be a claim rather than a hedge.
    if (readiness === undefined) return 'Pull request open';
    return `${readiness.spokenDetail}, ${PR_READINESS_FRESHNESS_CAVEAT}`;
  }
  if (prState === 'draft') return 'Pull request in draft';
  if (prState === 'merged') return 'Pull request merged';
  if (prState === 'closed') return 'Pull request closed';
  return 'Pull request open';
}
