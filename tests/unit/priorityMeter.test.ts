/**
 * The priority meter's rules against @kangentic/branding's own worked tables.
 * meter.json carries `examples` (bar count, lit count, width and opacities for
 * scales of 1 to 7 levels) and `pixelSnap.examples` (the snapped sizes at the
 * common device pixel ratios) precisely so a consumer can prove its
 * implementation, so every row of both runs through src/lib/priorityMeter.ts.
 * The tables are read from the INSTALLED package, never copied here, so a
 * branding bump that changes them is checked against the code on the spot.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PRIORITY_METER_BAR, PRIORITY_METER_OPACITY } from '../../src/brand/priorityMeter.generated';
import {
  priorityMeterBarCount,
  priorityMeterBarOpacity,
  priorityMeterGeometry,
  priorityMeterLitCount,
} from '../../src/lib/priorityMeter';

interface MeterExample {
  levelCount: number;
  level: number;
  width: number;
  lit: number;
  opacities: number[];
}

interface PixelSnapExample {
  dpr: number;
  device: { width: number; gap: number; height: number };
}

interface MeterManifest {
  bar: { width: number; height: number; gap: number; radius: number };
  opacity: { lit: number; unlit: number; none: number };
  examples: MeterExample[];
  pixelSnap: { examples: PixelSnapExample[] };
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../node_modules/@kangentic/branding/assets/priority/meter.json', import.meta.url)), 'utf8'),
) as MeterManifest;

/** The meter's drawn width at 1x, as meter.json's `rules.width` states it, from this module's own bar count. */
function meterWidth(barCount: number): number {
  return barCount * PRIORITY_METER_BAR.width + (barCount - 1) * PRIORITY_METER_BAR.gap;
}

describe('the priority meter against meter.json', () => {
  it('reads the worked tables at all', () => {
    expect(manifest.examples.length).toBeGreaterThan(0);
    expect(manifest.pixelSnap.examples.length).toBeGreaterThan(0);
  });

  it('generates exactly the numbers meter.json carries', () => {
    expect(PRIORITY_METER_BAR).toEqual(manifest.bar);
    expect(PRIORITY_METER_OPACITY).toEqual(manifest.opacity);
  });

  it.each(manifest.examples.map((example) => [`${example.levelCount} levels, level ${example.level}`, example] as const))(
    'draws %s as meter.json works it',
    (_name, example) => {
      const barCount = priorityMeterBarCount(example.levelCount);
      const litCount = priorityMeterLitCount(example.level, barCount);
      const opacities = Array.from({ length: barCount }, (_unused, barIndex) => priorityMeterBarOpacity(barIndex, example.level, litCount));

      expect(barCount).toBe(example.opacities.length);
      expect(litCount).toBe(example.lit);
      expect(meterWidth(barCount)).toBe(example.width);
      expect(opacities).toEqual(example.opacities);
    },
  );

  it.each(manifest.pixelSnap.examples.map((example) => [example.dpr, example] as const))(
    'snaps width, gap and height to whole device pixels at %sx',
    (_ratio, example) => {
      const geometry = priorityMeterGeometry(example.dpr);
      // Back to device pixels: each must land exactly on the table's whole number.
      expect(Math.round(geometry.width * example.dpr * 1000) / 1000).toBe(example.device.width);
      expect(Math.round(geometry.gap * example.dpr * 1000) / 1000).toBe(example.device.gap);
      expect(Math.round(geometry.height * example.dpr * 1000) / 1000).toBe(example.device.height);
    },
  );

  it('leaves the corner radius unsnapped', () => {
    expect(priorityMeterGeometry(2.625).radius).toBe(manifest.bar.radius);
  });
});
