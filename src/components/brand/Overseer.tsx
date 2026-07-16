import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import {
  OVERSEER_GRID_COLUMNS,
  OVERSEER_GRID_ROWS,
  overseerFrames,
  type OverseerFrameName,
  type OverseerRectRole,
} from '@/brand/overseerFrames.generated';
import { useTheme } from '../theme/ThemeProvider';
import type { BrandTokens } from '../theme/tokens';

export type OverseerAnimation = 'blink-loop' | 'wave-once' | 'none';

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

/** The wave one-shot: canonical lead-in, held wave frame, back to canonical. */
const WAVE_LEAD_FRACTION = 0.25;
const WAVE_HOLD_FRACTION = 0.5;

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
 * style: `blink-loop` blinks on a per-instance random phase so multiple
 * mascots never blink in unison, `wave-once` plays a single greeting wave.
 * When the OS requests reduced motion the mascot rests on the canonical frame.
 */
export function Overseer({ size, animate = 'none', testID = 'overseer' }: OverseerProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const [frameName, setFrameName] = useState<OverseerFrameName>('canonical');
  const overseerTimings = theme.motion.overseer;

  const animationActive = animate !== 'none' && !reducedMotion;
  const animationKey = animationActive ? animate : 'none';

  // Reset to the canonical frame when the animation mode changes (render-time
  // state adjustment, not a setState-in-effect; see usePromptAnswer for the
  // same pattern). The timers below only ever advance frames asynchronously.
  const [trackedAnimationKey, setTrackedAnimationKey] = useState(animationKey);
  if (trackedAnimationKey !== animationKey) {
    setTrackedAnimationKey(animationKey);
    setFrameName('canonical');
  }

  useEffect(() => {
    if (!animationActive) {
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    if (animate === 'blink-loop') {
      const scheduleNextBlink = (): void => {
        const intervalRange = overseerTimings.blinkIntervalMaxMs - overseerTimings.blinkIntervalMinMs;
        const intervalMs = overseerTimings.blinkIntervalMinMs + Math.random() * intervalRange;
        timeoutHandle = setTimeout(() => {
          setFrameName('blink');
          timeoutHandle = setTimeout(() => {
            setFrameName('canonical');
            scheduleNextBlink();
          }, overseerTimings.blinkHoldMs);
        }, intervalMs);
      };
      scheduleNextBlink();
    } else {
      // wave-once: canonical -> wave -> canonical inside waveDurationMs.
      timeoutHandle = setTimeout(() => {
        setFrameName('wave');
        timeoutHandle = setTimeout(() => {
          setFrameName('canonical');
        }, overseerTimings.waveDurationMs * WAVE_HOLD_FRACTION);
      }, overseerTimings.waveDurationMs * WAVE_LEAD_FRACTION);
    }

    return () => {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    };
  }, [animate, animationActive, overseerTimings]);

  const pixelScale = Math.max(1, Math.floor(size / OVERSEER_GRID_COLUMNS));
  const gridWidth = pixelScale * OVERSEER_GRID_COLUMNS;
  const gridHeight = pixelScale * OVERSEER_GRID_ROWS;

  const rectViews = useMemo(
    () =>
      overseerFrames[frameName].map((rect, rectIndex) => (
        <View
          key={`${frameName}-${rectIndex}`}
          style={{
            position: 'absolute',
            left: rect.x * pixelScale,
            top: rect.y * pixelScale,
            width: rect.width * pixelScale,
            height: rect.height * pixelScale,
            backgroundColor: colorForRole(rect.role, theme.brand),
          }}
        />
      )),
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
