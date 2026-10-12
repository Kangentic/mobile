import React from 'react';
import { ScreenMotionProvider } from '@/components/motion/ScreenMotion';
import { CommandTerminalScreen } from '@/screens/terminals/CommandTerminalScreen';

/**
 * An open Command Terminal. The motion gate sits in the route wrapper, as it
 * does for the task session route (`app/task/[taskId]/index.tsx`): a route
 * pushed over the screen stops the starting face's cursor and the header's
 * spinning Stop ring, and returning resumes them.
 */
export default function CommandTerminalRoute(): React.JSX.Element {
  return (
    <ScreenMotionProvider>
      <CommandTerminalScreen />
    </ScreenMotionProvider>
  );
}
