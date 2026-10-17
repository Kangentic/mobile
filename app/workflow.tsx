import React from 'react';
import { ScreenMotionProvider } from '@/components/motion/ScreenMotion';
import { WorkflowScreen } from '@/screens/workflow/WorkflowScreen';

/**
 * One workflow's view. The motion gate sits in the route wrapper, as it does
 * for the task session route: a route pushed over the view (a task opened from
 * it) stops its working rings, and returning resumes them.
 */
export default function WorkflowRoute(): React.JSX.Element {
  return (
    <ScreenMotionProvider>
      <WorkflowScreen />
    </ScreenMotionProvider>
  );
}
