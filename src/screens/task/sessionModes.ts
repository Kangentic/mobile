import { GitCompareArrows, MessagesSquare, SquareTerminal } from 'lucide-react-native';

export type SessionMode = 'terminal' | 'chat' | 'changes';

export interface SessionModeOption {
  mode: SessionMode;
  label: string;
  accessibilityLabel: string;
  Icon: typeof SquareTerminal;
}

/**
 * The three surfaces of one session, in display order.
 *
 * Deliberately only the surfaces. Move used to ride along here as a fourth
 * entry, which made a command look like a place you could be; it belongs to
 * the long-press actions hub.
 */
export const SESSION_MODE_OPTIONS: SessionModeOption[] = [
  { mode: 'terminal', label: 'Terminal', accessibilityLabel: 'Terminal view', Icon: SquareTerminal },
  { mode: 'chat', label: 'Chat', accessibilityLabel: 'Chat view', Icon: MessagesSquare },
  { mode: 'changes', label: 'Changes', accessibilityLabel: 'Changes view', Icon: GitCompareArrows },
];
