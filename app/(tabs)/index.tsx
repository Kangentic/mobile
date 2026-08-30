import React from 'react';
import { ScreenMotionProvider } from '@/components/motion/ScreenMotion';
import { TriageHomeScreen } from '@/screens/TriageHomeScreen';

/**
 * The gate lives in the route wrapper rather than in the screen because it is a
 * navigation concern: `useFocusEffect` needs a navigator, and the screen's own
 * component tests do not have one. This keeps the screen a plain component.
 */
export default function TriageHomeRoute(): React.JSX.Element {
  return (
    <ScreenMotionProvider>
      <TriageHomeScreen />
    </ScreenMotionProvider>
  );
}
