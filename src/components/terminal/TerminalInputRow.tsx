import React, { useCallback, useState } from 'react';
import { StyleSheet } from 'react-native';
import { IconButton, Row, Stack, Text, TextField } from '@/components';
import { ENTER } from '@/terminal/keySequences';
import { writeTerminal } from '@/connection/actions';

export interface TerminalInputRowProps {
  sessionId: string;
}

/**
 * The line-oriented terminal composer: type a command with the native
 * keyboard (autocorrect off - this is a shell, not a chat), send writes the
 * text plus Enter to the desktop PTY. The draft only clears on a successful
 * write; a failure keeps it and shows an inline error caption.
 */
export function TerminalInputRow({ sessionId }: TerminalInputRowProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const send = useCallback(() => {
    writeTerminal(sessionId, `${draft}${ENTER}`)
      .then(() => {
        setDraft('');
        setErrorMessage(null);
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : 'Could not send to the terminal');
      });
  }, [sessionId, draft]);

  return (
    <Stack gap="xs">
      <Row gap="xs">
        <TextField
          testID="terminal-input"
          mono
          placeholder="Type into the terminal"
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          // Terminals fire consecutive commands: keep the keyboard up after
          // the return key submits (default blurAndSubmit would dismiss it).
          submitBehavior="submit"
          onSubmitEditing={send}
          style={styles.flex}
        />
        <IconButton iconName="send" onPress={send} testID="terminal-input-send" accessibilityLabel="Send to terminal" />
      </Row>
      {errorMessage !== null ? (
        <Text variant="caption" color="danger" testID="terminal-input-error">
          {errorMessage}
        </Text>
      ) : null}
    </Stack>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
});
