import React, { useCallback } from 'react';
import { IconButton } from '@/components';
import { writeTerminal } from '@/connection/actions';
import { useSettingsStore } from '@/state/settingsStore';
import { useDictation } from '@/voice/useDictation';

export interface TerminalMicButtonProps {
  sessionId: string;
}

/**
 * Dictation straight into the desktop PTY: only the FINAL transcript is
 * written (partials would type-then-erase garbage in the TUI), with no
 * trailing return - the user reviews what landed in the TUI's input and
 * submits with Enter. Hidden when dictation is off or unavailable, same
 * as the chat composer's mic.
 */
export function TerminalMicButton({ sessionId }: TerminalMicButtonProps): React.JSX.Element | null {
  const dictationMode = useSettingsStore((state) => state.dictationMode);

  const dictation = useDictation({
    // Partials are ignored on purpose: streaming them would type garbage
    // into the PTY that then needs erasing.
    onPartialResult: () => undefined,
    onFinalResult: (finalText) => {
      const trimmedText = finalText.trim();
      if (trimmedText.length === 0) return;
      void writeTerminal(sessionId, trimmedText).catch(() => undefined);
    },
  });

  const onMicPress = useCallback(() => {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    dictation.start();
  }, [dictation]);

  if (dictationMode === 'off' || !dictation.available) return null;

  return (
    <IconButton
      iconName={dictation.listening ? 'mic' : 'mic-outline'}
      variant={dictation.listening ? 'fab' : 'plain'}
      testID={dictation.listening ? 'terminal-mic-active' : 'terminal-mic'}
      accessibilityLabel={dictation.listening ? 'Stop dictating into the terminal' : 'Dictate into the terminal'}
      onPress={onMicPress}
    />
  );
}
