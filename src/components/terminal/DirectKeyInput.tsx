import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { writeTerminal } from '@/connection/actions';

export interface DirectKeyInputHandle {
  /** Raise the soft keyboard if hidden, dismiss it if showing. */
  toggle: () => void;
  blur: () => void;
}

export interface DirectKeyInputProps {
  sessionId: string;
}

const SENTINEL = ' ';
/** Reset the grown buffer once it passes this length (on the next blur no matter what). */
const BUFFER_RESET_LENGTH = 400;

/**
 * The terminal's direct typing surface: an invisible native TextInput the
 * soft keyboard attaches to. Each change is diffed against the PREVIOUS
 * value (tracked in a ref, synchronously, so batched IME events can never
 * double-send - resetting the field per keystroke raced exactly that way)
 * and the delta streams to the desktop PTY: appended characters forward,
 * deletions as DEL, newlines as carriage returns. The buffer simply grows
 * while typing and resets on blur; the leading sentinel exists because
 * Android reports no change for backspace on an empty field.
 */
export const DirectKeyInput = forwardRef<DirectKeyInputHandle, DirectKeyInputProps>(function DirectKeyInput(
  { sessionId },
  ref,
): React.JSX.Element {
  const inputRef = useRef<TextInput>(null);
  const lastValueRef = useRef(SENTINEL);
  const [value, setValue] = useState(SENTINEL);

  useImperativeHandle(ref, () => ({
    toggle: () => {
      if (inputRef.current?.isFocused()) {
        inputRef.current.blur();
      } else {
        inputRef.current?.focus();
      }
    },
    blur: () => inputRef.current?.blur(),
  }));

  const sendToPty = useCallback(
    (data: string) => {
      if (data.length === 0) return;
      void writeTerminal(sessionId, data).catch(() => undefined);
    },
    [sessionId],
  );

  const onChangeText = useCallback(
    (nextText: string) => {
      const previousText = lastValueRef.current;
      if (nextText.length === 0) {
        // The buffer (sentinel included) was fully deleted: restore the
        // sentinel so the NEXT backspace is observable too. This is the
        // only mid-typing reset, and it sits on a rare edge - the
        // every-keystroke reset this replaced raced batched IME events.
        lastValueRef.current = SENTINEL;
        setValue(SENTINEL);
        sendToPty('\x7f'.repeat(previousText.length));
        return;
      }
      lastValueRef.current = nextText;
      setValue(nextText);
      if (nextText === previousText) return;
      if (nextText.startsWith(previousText)) {
        // Appended characters.
        sendToPty(nextText.slice(previousText.length).replaceAll('\n', '\r'));
      } else if (previousText.startsWith(nextText)) {
        // End deletions.
        sendToPty('\x7f'.repeat(previousText.length - nextText.length));
      } else {
        // A tail replacement (autocorrect/IME rewrite): erase the divergent
        // tail, then type the new one.
        let commonLength = 0;
        const maxCommon = Math.min(previousText.length, nextText.length);
        while (commonLength < maxCommon && previousText[commonLength] === nextText[commonLength]) commonLength++;
        sendToPty('\x7f'.repeat(previousText.length - commonLength));
        sendToPty(nextText.slice(commonLength).replaceAll('\n', '\r'));
      }
    },
    [sendToPty],
  );

  const onBlur = useCallback(() => {
    // Safe reset point: no IME edits can race a dismissed keyboard.
    lastValueRef.current = SENTINEL;
    setValue(SENTINEL);
  }, []);

  const onFocus = useCallback(() => {
    if (lastValueRef.current.length > BUFFER_RESET_LENGTH) {
      lastValueRef.current = SENTINEL;
      setValue(SENTINEL);
    }
  }, []);

  return (
    <TextInput
      ref={inputRef}
      testID="terminal-direct-key-input"
      accessible={false}
      importantForAccessibility="no"
      style={styles.hidden}
      value={value}
      onChangeText={onChangeText}
      onBlur={onBlur}
      onFocus={onFocus}
      multiline
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      autoComplete="off"
      caretHidden
      contextMenuHidden
    />
  );
});

const styles = StyleSheet.create({
  hidden: {
    height: 1,
    left: 0,
    opacity: 0,
    position: 'absolute',
    top: 0,
    width: 1,
  },
});
