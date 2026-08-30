import React from 'react';
import { ScreenMotionProvider } from '@/components/motion/ScreenMotion';
import { BoardScreen } from '@/screens/BoardScreen';

/** See `app/(tabs)/index.tsx` for why the motion gate sits in the route wrapper. */
export default function BoardRoute(): React.JSX.Element {
  return (
    <ScreenMotionProvider>
      <BoardScreen />
    </ScreenMotionProvider>
  );
}
