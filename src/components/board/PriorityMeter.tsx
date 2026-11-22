import React from 'react';
import { PixelRatio, StyleSheet, View } from 'react-native';
import type { CardPriorityLevel } from '@/lib/priority';
import { priorityMeterBarCount, priorityMeterBarOpacity, priorityMeterGeometry, priorityMeterLitCount } from '@/lib/priorityMeter';

/**
 * A task's priority as the desktop card draws it since kangentic #1160: a bare
 * meter of equal bars at the right end of the title row, one bar per level
 * above the scale's bottom entry, lit from the left up to the task's level, in
 * the level's own color. Every number and rule comes from @kangentic/branding's
 * `assets/priority/meter.json` (see src/lib/priorityMeter.ts), which the
 * desktop and the web demo draw from too.
 *
 * Views, not the package's meter SVGs: the phone's SVG path for brand marks
 * strokes a rect as an outline and drops `fill-opacity` (the branding README
 * says so), and plain Views need no SVG at all.
 *
 * Width, gap and height snap once to whole device pixels at the screen's ratio
 * (`pixelSnap`), so the bars come out equal at every density. The bar height is
 * the 14 dp title's capital height (meter.json's `alignment`), so the title
 * row's center alignment centers it with no offset. Pass only a level `priorityLevelFor` returned,
 * which leaves out the bottom of the scale: a card at the bottom draws no
 * meter and keeps no slot for one.
 *
 * The meter is decorative. The View around it carries the level's name, as
 * meter.json's `accessibility` asks ("Priority: High"), and the testID.
 * Static: no animated hooks (motion-conventions.md).
 */
export function PriorityMeter({ level, testID }: { level: CardPriorityLevel; testID?: string }): React.JSX.Element {
  const geometry = priorityMeterGeometry(PixelRatio.get());
  const barCount = priorityMeterBarCount(level.levelCount);
  const litCount = priorityMeterLitCount(level.level, barCount);
  const bars: React.JSX.Element[] = [];
  for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
    bars.push(
      <View
        key={barIndex}
        testID={testID === undefined ? undefined : `${testID}-bar-${barIndex}`}
        style={{
          width: geometry.width,
          height: geometry.height,
          borderRadius: geometry.radius,
          backgroundColor: level.color,
          opacity: priorityMeterBarOpacity(barIndex, level.level, litCount),
        }}
      />,
    );
  }
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Priority: ${level.label}`}
      style={[styles.meter, { gap: geometry.gap, height: geometry.height }]}
    >
      {bars}
    </View>
  );
}

const styles = StyleSheet.create({
  meter: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
});
