import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

export interface SheetScrollerSlotProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * A dedicated, never-flattened, clipping parent for any ScrollView inside a
 * 'fitToContents' form sheet. On iOS Fabric, react-native-screens mounts a
 * scroll view inside a form sheet at its parent's literal (0,0) instead of
 * its layout origin (react-native-screens' RNSScreenContentWrapper.mm calls
 * the cause unknown and repairs only hierarchies it can find, which ours is
 * not). The 2026-08-15 tester recording shows the result: the Move sheet's
 * rows painted over the sheet title, shifted up and left by exactly the
 * container padding. This wrapper occupies the scroller's slot itself, so a
 * scroll view mounted at its parent's (0,0) lands exactly where layout put
 * the slot, and overflow: 'hidden' clips anything that still paints past it.
 *
 * Load-bearing invariants, none of which the compiler can enforce:
 * - collapsable={false} and overflow: 'hidden' each force a real native view;
 *   without them Fabric flattens this wrapper away and nothing is fixed.
 * - The height cap (maxHeight) stays on the ScrollView child, never here: a
 *   wrapper-level cap would let the scroll view size itself to its full
 *   content, believe viewport equals content, and never scroll, leaving the
 *   clipped remainder unreachable.
 * - testID and keyboardShouldPersistTaps stay on the ScrollView child.
 * - A sheet's container must keep a non-scrollable first child (the title
 *   Text) and this slot must never become a direct child of the screen
 *   content wrapper: react-native-screens searches those two positions for a
 *   scroll view and force-resizes whatever it finds to the full sheet size,
 *   which is worse than the bug this wrapper fixes.
 */
export function SheetScrollerSlot({ children, style }: SheetScrollerSlotProps): React.JSX.Element {
  return (
    <View collapsable={false} style={[styles.slot, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    overflow: 'hidden',
  },
});
