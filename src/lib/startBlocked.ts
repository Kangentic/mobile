/**
 * Why a task's last start never reached its agent (protocol 0.28.0's
 * `BoardTaskWire.start_blocked_reason`), in the desktop card's words
 * (kangentic `task-card-view.tsx`, `useStartBlockedCopy`). The card draws the
 * label in its warning tone in place of "Paused"; the tip, which the desktop
 * shows on hover, goes under the phone's Resume button and into the footer's
 * accessibility label.
 *
 * The wire carries a widened string, so a reason this phone does not know
 * reads as null and the card says plain "Paused", as the protocol asks.
 */
export interface StartBlockedCopy {
  label: string;
  tip: string;
}

const START_BLOCKED_COPY: Record<string, StartBlockedCopy> = {
  'worktree-missing': { label: 'Worktree missing', tip: 'Its worktree folder is gone. Resume makes it again from the branch.' },
  'folder-missing': { label: 'Folder missing', tip: 'The folder this agent starts in is gone.' },
  'never-started': { label: "Didn't start", tip: 'The agent never reported that it started.' },
  'spawn-failed': { label: "Didn't start", tip: 'The terminal could not start. Its window shows why.' },
  'prompt-too-long': { label: "Didn't start", tip: 'Its prompt is too long for this agent to start with.' },
};

export function startBlockedCopy(reason: string | null | undefined): StartBlockedCopy | null {
  if (reason === null || reason === undefined) return null;
  return Object.prototype.hasOwnProperty.call(START_BLOCKED_COPY, reason) ? START_BLOCKED_COPY[reason] : null;
}
