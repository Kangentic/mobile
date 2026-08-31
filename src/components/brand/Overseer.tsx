import React, { useEffect, useMemo, useState } from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import {
  OVERSEER_GRID_COLUMNS,
  OVERSEER_GRID_ROWS,
  OVERSEER_REST_FRAME,
  overseerFrames,
  overseerSequences,
  type OverseerAnimation,
  type OverseerFrameName,
  type OverseerRectRole,
} from '@/brand/overseerFrames.generated';
import { useScreenMotionActive } from '../motion/ScreenMotion';
import { useTheme } from '../theme/ThemeProvider';
import type { BrandTokens } from '../theme/tokens';

export { type OverseerAnimation, overseerOneShotDurationMs, type OverseerOneShotAnimation } from '@/brand/overseerFrames.generated';

export interface OverseerProps {
  /**
   * Intended width in dp. The renderer snaps DOWN to an integer per-pixel
   * scale (multiples of the 18-column grid keep exactly this width; anything
   * else rounds down) so the mascot's pixels never land on fractional dp and
   * blur.
   */
  size: number;
  animate?: OverseerAnimation;
  testID?: string;
}

function colorForRole(role: OverseerRectRole, brand: BrandTokens): string {
  switch (role) {
    case 'body':
      return brand.amber;
    case 'ink':
      return brand.ink;
    case 'highlight':
      return brand.cream;
  }
}

/**
 * The Overseer mascot as a crisp pixel grid of plain Views (no SVG rasterizing
 * at runtime, ~35 memoized Views per frame). Frames swap discretely, pixel-art
 * style, driven entirely by the sequence data generated from
 * @kangentic/branding's motion manifest (overseerSequences): a `clip` is a
 * fixed timeline of frames, an optional `idle` is a gap before each pass
 * (right-skewed via a squared draw, per the manifest's `bias: "square"`), and
 * an optional `repeat` is a same-pass reroll (a double blink) gated to fire
 * at most once per pass. Adding a sequence upstream needs no code here. When
 * the OS requests reduced motion the mascot rests on the rest frame.
 *
 * The same focus gate `AgentStatusIcon` and `Skeleton` use applies here:
 * `useScreenMotionActive()` is false while another route covers this screen, so
 * the mascot rests on the rest frame instead of re-rendering its ~35-View grid
 * for nobody. `waiting-loop` in particular is 2.5 setStates/second; running it
 * behind a pushed route is the exact waste `ScreenMotion` exists to stop, and
 * this component was the one that was missing the gate. Outside a
 * `ScreenMotionProvider` the hook returns true, so a bare render (every
 * component test) animates exactly as before.
 */
export function Overseer({ size, animate = 'none', testID = 'overseer' }: OverseerProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const [frameName, setFrameName] = useState<OverseerFrameName>(OVERSEER_REST_FRAME);
  const sequence = overseerSequences[animate];

  const animationActive = !reducedMotion && screenMotionActive && sequence.clip.length > 0;
  const animationKey = animationActive ? animate : 'none';

  // Reset to the rest frame when the animation mode changes (render-time
  // state adjustment, not a setState-in-effect; see usePromptAnswer for the
  // same pattern). The timers below only ever advance frames asynchronously.
  const [trackedAnimationKey, setTrackedAnimationKey] = useState(animationKey);
  if (trackedAnimationKey !== animationKey) {
    setTrackedAnimationKey(animationKey);
    setFrameName(OVERSEER_REST_FRAME);
  }

  useEffect(() => {
    if (!animationActive) {
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    // Every pass draws Math.random() in this fixed order: the idle gap (if
    // any), then the repeat roll, then the repeat gap - so a test mocking
    // Math.random can predict exactly which call it is answering.
    const runClipStep = (stepIndex: number, alreadyRepeated: boolean): void => {
      const step = sequence.clip[stepIndex];
      setFrameName(step.frame);
      timeoutHandle = setTimeout(() => {
        if (stepIndex + 1 < sequence.clip.length) {
          runClipStep(stepIndex + 1, alreadyRepeated);
          return;
        }
        const repeat = sequence.repeat;
        if (repeat !== undefined && !alreadyRepeated && Math.random() < repeat.chance) {
          setFrameName(OVERSEER_REST_FRAME);
          const gapMs = repeat.gapMinMs + Math.random() * (repeat.gapMaxMs - repeat.gapMinMs);
          timeoutHandle = setTimeout(() => runClipStep(0, true), gapMs);
          return;
        }
        if (sequence.loop) {
          startPass();
          return;
        }
        setFrameName(OVERSEER_REST_FRAME);
      }, step.durationMs);
    };

    const startPass = (): void => {
      const idle = sequence.idle;
      if (idle === undefined) {
        runClipStep(0, false);
        return;
      }
      setFrameName(idle.frame);
      // Right-skewed draw per the manifest's bias: "square" - a single draw,
      // squared, so gaps cluster short with the odd long pause rather than a
      // flat spread.
      const drawn = Math.random();
      const gapMs = idle.minMs + (idle.maxMs - idle.minMs) * drawn * drawn;
      timeoutHandle = setTimeout(() => runClipStep(0, false), gapMs);
    };

    startPass();

    return () => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    };
  }, [animationActive, sequence]);

  const pixelScale = Math.max(1, Math.floor(size / OVERSEER_GRID_COLUMNS));
  const gridWidth = pixelScale * OVERSEER_GRID_COLUMNS;
  const gridHeight = pixelScale * OVERSEER_GRID_ROWS;

  const rectViews = useMemo(
    () =>
      overseerFrames[frameName].map((rect, rectIndex) => {
        // Round each EDGE (not width/height independently) to the nearest
        // physical pixel. Two rects sharing a grid boundary compute the same
        // edge from the same input, so they land on the identical physical
        // pixel and abut exactly - fixing the hairline seams that show the
        // background through between adjacent rows/columns (most visible at
        // the head's stacked single-rect rows and the multi-rect eye/feet
        // rows) when the device's pixel ratio doesn't divide evenly.
        const left = PixelRatio.roundToNearestPixel(rect.x * pixelScale);
        const top = PixelRatio.roundToNearestPixel(rect.y * pixelScale);
        const right = PixelRatio.roundToNearestPixel((rect.x + rect.width) * pixelScale);
        const bottom = PixelRatio.roundToNearestPixel((rect.y + rect.height) * pixelScale);
        return (
          <View
            key={`${frameName}-${rectIndex}`}
            style={{
              position: 'absolute',
              left,
              top,
              width: right - left,
              height: bottom - top,
              backgroundColor: colorForRole(rect.role, theme.brand),
            }}
          />
        );
      }),
    [frameName, pixelScale, theme.brand],
  );

  return (
    <View
      testID={testID}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={{ width: gridWidth, height: gridHeight }}
    >
      {/* The frame marker view lets tests (and the inspect loop) read which
          frame is showing without decoding pixel rects. */}
      <View testID={`${testID}-frame-${frameName}`} style={StyleSheet.absoluteFill}>
        {rectViews}
      </View>
    </View>
  );
}
