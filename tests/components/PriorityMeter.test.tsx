import React from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { PRIORITY_METER_BAR } from '@/brand/priorityMeter.generated';
import { PriorityMeter } from '@/components/board/PriorityMeter';
import { priorityMeterGeometry } from '@/lib/priorityMeter';

/**
 * Pins that the pixel-snapped geometry REACHES the drawn Views. The unit tier
 * checks priorityMeterGeometry alone; this fails if PriorityMeter drew the raw
 * PRIORITY_METER_BAR width/height (bars), dropped borderRadius, or dropped the
 * wrapper's gap/height. 2.625 is a ratio where every snapped value differs from
 * the raw 1x number, so a revert to raw numbers cannot pass by accident.
 */
const RATIO = 2.625;
const TEST_ID = 'meter';
const LEVEL = { label: 'High', color: '#f97316', level: 3, levelCount: 5 };

function flatStyle(testID: string): ViewStyle {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style as StyleProp<ViewStyle>) ?? {};
}

describe('PriorityMeter geometry', () => {
  beforeEach(() => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(RATIO);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('snaps to numbers that differ from the raw 1x bar (guards the test itself)', () => {
    const geometry = priorityMeterGeometry(RATIO);
    expect(geometry.width).not.toBe(PRIORITY_METER_BAR.width);
    expect(geometry.height).not.toBe(PRIORITY_METER_BAR.height);
    expect(geometry.gap).not.toBe(PRIORITY_METER_BAR.gap);
  });

  it('draws every bar at the snapped width and height with the unsnapped radius', async () => {
    await render(<PriorityMeter level={LEVEL} testID={TEST_ID} />);
    const geometry = priorityMeterGeometry(RATIO);
    for (let barIndex = 0; barIndex < 4; barIndex += 1) {
      const style = flatStyle(`${TEST_ID}-bar-${barIndex}`);
      expect(style.width).toBe(geometry.width);
      expect(style.height).toBe(geometry.height);
      expect(style.borderRadius).toBe(PRIORITY_METER_BAR.radius);
    }
  });

  it('gives the wrapper the snapped gap and height', async () => {
    await render(<PriorityMeter level={LEVEL} testID={TEST_ID} />);
    const geometry = priorityMeterGeometry(RATIO);
    expect(screen.getByTestId(TEST_ID).props.accessibilityLabel).toBe('Priority: High');
    const style = flatStyle(TEST_ID);
    expect(style.gap).toBe(geometry.gap);
    expect(style.height).toBe(geometry.height);
  });
});
