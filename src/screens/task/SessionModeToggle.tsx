import React from 'react';
import { SegmentedSwitcher } from '@/components';
import { SESSION_MODE_OPTIONS, type SessionMode } from './sessionModes';

export type { SessionMode } from './sessionModes';

export interface SessionModeToggleProps {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  /**
   * True when something on the chat side needs the user (a pending
   * permission/question) while another surface is showing: the Chat segment
   * grows a needs-you dot. Never auto-switches.
   */
  chatAttention: boolean;
}

/**
 * The session's surface switcher: one session, three surfaces - Terminal,
 * Chat, Changes - as a full-width control anchoring the footer.
 *
 * The switcher itself is the shared SegmentedSwitcher primitive, which the
 * completed-task screen also uses for its two surfaces. This wrapper is what
 * makes it THIS session's switcher: the three surfaces, and the rule that
 * only Chat can raise a needs-you dot.
 */
export function SessionModeToggle({ mode, onModeChange, chatAttention }: SessionModeToggleProps): React.JSX.Element {
  return (
    <SegmentedSwitcher<SessionMode>
      testIDPrefix="session-mode"
      options={SESSION_MODE_OPTIONS}
      mode={mode}
      onModeChange={onModeChange}
      attentionMode={chatAttention ? 'chat' : null}
    />
  );
}
