/**
 * GENERATED FILE. Do not hand-edit. Regenerate with: node scripts/syncBranding.mjs
 * Source: the @kangentic/branding package (assets change there, never here).
 * This file carries brand asset data, the one sanctioned exception to the
 * "hex values live only in src/components/theme/tokens.ts" rule.
 */

/**
 * The activity status marks as typed shape data, parsed from
 * @kangentic/branding/assets/activity/*.svg and its activity.json contract.
 * Structured elements rather than inlined XML, because the working mark
 * MARCHES: its stroke-dashoffset is animated, and an animated prop needs a
 * real addressable node, which an SvgXml blob cannot give.
 *
 * Every mark is currentColor, so the consumer supplies the tone and no hex
 * appears here. Dashes are the manifest's USER-UNIT form, never the
 * pathLength ratio: react-native-svg does not honour pathLength, and a "75"
 * dash covers the 56-unit agent ring entirely, so the motion disappears.
 * pathLength is dropped by construction - this module emits typed
 * attributes rather than passing SVG through.
 */

export type ActivityMarkName = 'agent-idle' | 'agent-working';

/** How a mark renders when the OS asks for reduced motion. */
export type ActivityRestRendering = 'static' | 'keep-dash' | 'drop-dash';

export interface ActivityRectShape {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  rx: number;
}

export interface ActivityCircleShape {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
  /** The user-unit stroke dash, present only on the outline that marches. */
  dash?: readonly [number, number];
}

export interface ActivityPathShape {
  kind: 'path';
  d: string;
}

export type ActivityShape = ActivityRectShape | ActivityCircleShape | ActivityPathShape;

export interface ActivityMarchMotion {
  durationMs: number;
  /** One full dash cycle in user units: how far the offset travels per pass. */
  periodUserUnits: number;
}

export interface ActivityMark {
  shapes: readonly ActivityShape[];
  /** Present only on a marching mark. */
  march?: ActivityMarchMotion;
  restRendering: ActivityRestRendering;
  /** Below this rendered size, draw a dot instead of the mark. */
  minPx: number;
}

export const ACTIVITY_VIEW_BOX = '0 0 24 24';
export const ACTIVITY_STROKE_WIDTH = 2;
export const ACTIVITY_STROKE_LINECAP = 'round';
export const ACTIVITY_STROKE_LINEJOIN = 'round';

export const activityMarks: Record<ActivityMarkName, ActivityMark> = {
  'agent-idle': {
    shapes: [
      { kind: 'rect', x: 3, y: 4.8, width: 18, height: 14.4, rx: 2 },
      { kind: 'path', d: 'M3 7.5 L12 12.6566 L21 7.5' },
    ],
    restRendering: 'static',
    minPx: 12,
  },
  'agent-working': {
    shapes: [
      { kind: 'circle', cx: 12, cy: 12, r: 9, dash: [42.4115, 14.1372] },
    ],
    march: { durationMs: 1400, periodUserUnits: 56.5487 },
    restRendering: 'keep-dash',
    minPx: 12,
  },
};
