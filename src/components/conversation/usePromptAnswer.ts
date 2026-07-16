import { useCallback, useEffect, useRef, useState } from 'react';
import { answerPermissionPrompt } from '@/connection/actions';

/**
 * The desktop's answer-permission-prompt rejection wording when the prompt
 * was already resolved (answered on the desktop, or superseded): treated as
 * "already answered" rather than a retryable failure.
 */
const STALE_PROMPT_MESSAGE_PATTERN = /does not match|No permission prompt/i;

export interface PromptAnswerLifecycle {
  /** True from submit until a retryable failure; stays true after success (the activity feed removes the card). */
  answering: boolean;
  /** Non-null when the prompt turned out to be already answered on the desktop; the card stays disabled. */
  answeredNote: string | null;
  /** Non-null after a retryable failure; the card re-enables. */
  errorNote: string | null;
  submit: (keystrokes: string) => void;
}

/**
 * Shared answer lifecycle for the permission and AskUserQuestion cards. On
 * success the card stays disabled and waits for the desktop's permission
 * event to remove it; a stale-prompt rejection pins an "already answered"
 * note; any other error surfaces inline and re-enables the buttons.
 */
export function usePromptAnswer(sessionId: string, promptId: string): PromptAnswerLifecycle {
  const [answering, setAnswering] = useState(false);
  const [answeredNote, setAnsweredNote] = useState<string | null>(null);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset lifecycle state when FlashList recycles this card for a different prompt.
  const [trackedPromptId, setTrackedPromptId] = useState(promptId);
  if (trackedPromptId !== promptId) {
    setTrackedPromptId(promptId);
    setAnswering(false);
    setAnsweredNote(null);
    setErrorNote(null);
  }

  const submit = useCallback(
    (keystrokes: string) => {
      setAnswering(true);
      setErrorNote(null);
      void answerPermissionPrompt(sessionId, promptId, keystrokes).catch((error: unknown) => {
        if (!mountedRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        if (STALE_PROMPT_MESSAGE_PATTERN.test(message)) {
          setAnswering(false);
          setAnsweredNote('Already answered on the desktop');
        } else {
          setAnswering(false);
          setErrorNote(message);
        }
      });
    },
    [sessionId, promptId],
  );

  return { answering, answeredNote, errorNote, submit };
}
