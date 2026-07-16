import React from 'react';
import { ConversationTab } from './ConversationTab';

export interface ChatPaneProps {
  taskId: string;
  sessionId: string | null;
  projectId: string | null;
}

/**
 * The Session screen's chat lens. Today it renders the structured transcript
 * feed; this is the seam where the agent-agnostic cleaned reading view lands
 * for sessions whose agent has no structured transcript (the ChatPane
 * chooses per session, the screen above never cares).
 */
export function ChatPane({ taskId, sessionId, projectId }: ChatPaneProps): React.JSX.Element {
  return <ConversationTab key={sessionId ?? 'no-session'} taskId={taskId} sessionId={sessionId} projectId={projectId} />;
}
