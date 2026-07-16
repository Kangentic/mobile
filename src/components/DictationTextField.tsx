import React, { useCallback, useRef } from 'react';
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import { IconButton } from './IconButton';
import { Row } from './Row';
import { TextField } from './TextField';
import { useSettingsStore } from '@/state/settingsStore';
import { useDictation } from '@/voice/useDictation';

export interface DictationTextFieldProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder: string;
  testID: string;
  multiline?: boolean;
  style?: StyleProp<TextStyle>;
}

/** Appends dictated text to whatever was typed before dictation began, inserting one space if needed. */
function joinDictationText(baseText: string, dictatedText: string): string {
  if (baseText.length === 0) return dictatedText;
  if (dictatedText.length === 0) return baseText;
  const separator = /\s$/.test(baseText) ? '' : ' ';
  return `${baseText}${separator}${dictatedText}`;
}

/**
 * A TextField with a dictation mic: partial results stream into the field
 * and a final result APPENDS (never auto-sends - auto-send is a composer
 * concept; a form field only collects text). Used by the task create/edit
 * description fields; the conversation ComposerBar keeps its own richer
 * integration.
 */
export function DictationTextField({
  value,
  onChangeText,
  placeholder,
  testID,
  multiline = false,
  style,
}: DictationTextFieldProps): React.JSX.Element {
  const dictationMode = useSettingsStore((state) => state.dictationMode);
  // What was in the field when dictation began; partials append after this.
  const dictationBaseRef = useRef('');

  const dictation = useDictation({
    onPartialResult: (partialText) => {
      onChangeText(joinDictationText(dictationBaseRef.current, partialText));
    },
    onFinalResult: (finalText) => {
      const combinedText = joinDictationText(dictationBaseRef.current, finalText);
      dictationBaseRef.current = combinedText;
      onChangeText(combinedText);
    },
  });

  const onMicPress = useCallback(() => {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    dictationBaseRef.current = value;
    dictation.start();
  }, [dictation, value]);

  const showMicButton = dictationMode !== 'off' && dictation.available;

  return (
    <Row gap="xs" style={styles.row}>
      <TextField
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        multiline={multiline}
        testID={testID}
        style={[styles.field, style]}
      />
      {showMicButton ? (
        <IconButton
          iconName={dictation.listening ? 'mic' : 'mic-outline'}
          variant={dictation.listening ? 'fab' : 'plain'}
          testID={`${testID}-mic`}
          accessibilityLabel={dictation.listening ? 'Stop dictation' : 'Start dictation'}
          onPress={onMicPress}
        />
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: 'flex-end',
  },
  field: {
    flex: 1,
  },
});
