import React from 'react';
import { ScreenMotionProvider } from '@/components/motion/ScreenMotion';
import { SessionScreen } from '@/screens/task/SessionScreen';

/**
 * The session screen hosts one looping animation, the swap veil's pulse, so
 * the motion gate sits in the route wrapper exactly as it does for the tab
 * routes (see `app/(tabs)/index.tsx`): a route pushed over a swap in flight
 * (the file diff, the move-task sheet) stops the pulse, and returning resumes
 * it. The header's activity ring gets the same gate for free.
 */
export default function TaskSessionRoute(): React.JSX.Element {
  return (
    <ScreenMotionProvider>
      <SessionScreen />
    </ScreenMotionProvider>
  );
}
