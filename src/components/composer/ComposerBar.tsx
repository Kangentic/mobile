import React, { useCallback, useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';
import { IconButton, Row, Text, TextField, useTheme } from '@/components';
import { sendUserMessage } from '@/connection/actions';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';
import { reportHandledError } from '@/observability/crashReporting';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useDictation } from '@/voice/useDictation';

export interface ComposerBarProps {
  sessionId: string;
}

const COMPOSER_MAX_HEIGHT = 120;

/** Appends dictated text to whatever was typed before dictation began, inserting one space if needed. */
function joinDictationText(baseText: string, dictatedText: string): string {
  if (baseText.length === 0) return dictatedText;
  if (dictatedText.length === 0) return baseText;
  const separator = /\s$/.test(baseText) ? '' : ' ';
  return `${baseText}${separator}${dictatedText}`;
}

/**
 * The conversation footer: a growing multiline input, a send button gated on
 * channel establishment, and a dictation mic (hidden when dictation is off
 * or the engine is unavailable). Partial dictation results stream into the
 * input; a final result auto-sends when the setting says so.
 */
export function ComposerBar({ sessionId }: ComposerBarProps): React.JSX.Element {
  const theme = useTheme();
  const established = useChannelStore((state) => state.established);
  const dictationMode = useSettingsStore((state) => state.dictationMode);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);
  // Mirror of `text` for callbacks that must read the latest value without re-binding.
  const textRef = useRef('');
  // What was in the input when dictation began; partials append after this.
  const dictationBaseRef = useRef('');

  const updateText = useCallback((nextText: string) => {
    textRef.current = nextText;
    setText(nextText);
  }, []);

  const sendText = useCallback(
    (messageText: string) => {
      const trimmedText = messageText.trim();
      if (trimmedText.length === 0) return;
      setSending(true);
      setErrorNote(null);
      void sendUserMessage(sessionId, trimmedText)
        .then(() => {
          textRef.current = '';
          dictationBaseRef.current = '';
          setText('');
        })
        .catch((error: unknown) => {
          reportHandledError('composer-send', error);
          // Keep the text so the user can retry.
          setErrorNote(error instanceof Error ? error.message : 'Message failed to send');
        })
        .finally(() => setSending(false));
    },
    [sessionId],
  );

  const onDictationStart = useCallback(() => {
    dictationBaseRef.current = textRef.current;
  }, []);

  const onPartialResult = useCallback(
    (partialText: string) => {
      updateText(joinDictationText(dictationBaseRef.current, partialText));
    },
    [updateText],
  );

  const onFinalResult = useCallback(
    (finalText: string) => {
      const combinedText = joinDictationText(dictationBaseRef.current, finalText);
      updateText(combinedText);
      dictationBaseRef.current = combinedText;
      if (useSettingsStore.getState().dictationMode === 'auto-send') {
        sendText(combinedText);
      } else {
        inputRef.current?.focus();
      }
    },
    [sendText, updateText],
  );

  const sendDisabled = sending || !established || text.trim().length === 0;

  // The parent footer (SessionInputBar) owns the border and outer padding so
  // the terminal/chat input rows sit at IDENTICAL geometry - toggling the
  // lens must not shift the bottom rows by a pixel.
  return (
    <View>
      {errorNote !== null ? (
        <Text variant="caption" color="danger" style={{ paddingHorizontal: theme.spacing.xs }}>
          {errorNote}
        </Text>
      ) : null}
      <Row gap="sm" style={styles.inputRow}>
        {/* Read at render, not subscribed: one composer mounts per session
            open, so a probe switch takes effect on the NEXT open, which is
            exactly the open/close cycle this arm measures. */}
        {getRetentionProbeVariant() === 'composer-no-dictation' ? null : (
          <DictationMicButton
            dictationEnabled={dictationMode !== 'off'}
            onStart={onDictationStart}
            onPartialResult={onPartialResult}
            onFinalResult={onFinalResult}
          />
        )}
        <TextField
          ref={inputRef}
          testID="composer-input"
          multiline
          value={text}
          onChangeText={updateText}
          placeholder="Message the agent"
          style={[styles.input, { maxHeight: COMPOSER_MAX_HEIGHT }]}
        />
        <IconButton
          iconName="send"
          variant="raised"
          testID="composer-send"
          accessibilityLabel="Send message"
          disabled={sendDisabled}
          onPress={() => sendText(textRef.current)}
        />
      </Row>
    </View>
  );
}

interface DictationMicButtonProps {
  /** False when the user has dictation off; the engine still subscribes, the mic is just hidden. */
  dictationEnabled: boolean;
  /** Runs before a new utterance starts, so partials append to what was typed. */
  onStart: () => void;
  onPartialResult: (text: string) => void;
  onFinalResult: (text: string) => void;
}

/**
 * The mic and the dictation engine subscription it needs, as one child.
 *
 * A separate component so the speech-event listeners register only where this
 * mounts. That is what lets the retention probe's 'composer-no-dictation' arm
 * drop them from a session screen without a conditional hook call. The shipped
 * path mounts it unconditionally, so registration and rendering are unchanged.
 * A child that renders null adds no native view, so `Row`'s `gap` is unaffected.
 */
function DictationMicButton({
  dictationEnabled,
  onStart,
  onPartialResult,
  onFinalResult,
}: DictationMicButtonProps): React.JSX.Element | null {
  const dictation = useDictation({ onPartialResult, onFinalResult });

  const onMicPress = useCallback(() => {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    onStart();
    dictation.start();
  }, [dictation, onStart]);

  if (!dictationEnabled || !dictation.available) return null;

  return (
    <IconButton
      iconName="mic"
      variant={dictation.listening ? 'fab' : 'raised'}
      testID={dictation.listening ? 'composer-mic-active' : 'composer-mic'}
      accessibilityLabel={dictation.listening ? 'Stop dictation' : 'Start dictation'}
      onPress={onMicPress}
    />
  );
}

const styles = StyleSheet.create({
  inputRow: {
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    // Android top-aligns multiline text; center it so the placeholder and a
    // single typed line sit mid-field like every chat composer.
    textAlignVertical: 'center',
  },
});
