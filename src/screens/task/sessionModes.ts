import { GitCompareArrows, MessagesSquare, SquareTerminal } from 'lucide-react-native';
import type { SegmentOption } from '@/components';

export type SessionMode = 'terminal' | 'chat' | 'changes';

/**
 * The three surfaces of one session, in display order.
 *
 * Deliberately only the surfaces. Move used to ride along here as a fourth
 * entry, which made a command look like a place you could be; it belongs to
 * the long-press actions hub.
 */
export const SESSION_MODE_OPTIONS: SegmentOption<SessionMode>[] = [
  { mode: 'terminal', label: 'Terminal', accessibilityLabel: 'Terminal view', Icon: SquareTerminal },
  { mode: 'chat', label: 'Chat', accessibilityLabel: 'Chat view', Icon: MessagesSquare },
  { mode: 'changes', label: 'Changes', accessibilityLabel: 'Changes view', Icon: GitCompareArrows },
];
