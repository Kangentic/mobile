import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Play } from 'lucide-react-native';
import { Button, StatusSpinner, Stack, Text, useTheme } from '@/components';
import { resumeTaskSession } from '@/connection/actions';
import type { ResumeAttempt } from '@/state/resumeStore';
import { RESUME_FAILED_MESSAGE } from './useResumeOffer';

/** The desktop's wording, verbatim (TaskDetailBody.tsx). */
const RESUME_LABEL = 'Resume session';
const RESUMING_LABEL = 'Resuming agent...';
const GLYPH_SIZE = 16;

/**
 * What the terminal lens shows for a paused session: the desktop task view's
 * body for a suspended task (TaskDetailBody.tsx), a "Resume session" button
 * centred where the terminal would be. While the resume runs it reads
 * "Resuming agent..." with a spinner and cannot be pressed again; if it fails,
 * the desktop's line appears under it (the desktop's own refusal text when it
 * sent one) and the button is live again for a retry.
 *
 * Drawn over the terminal pane rather than in place of it: the xterm WebView
 * must never unmount, and the opaque panel hides it exactly as the desktop's
 * body hides its terminal.
 */
export function ResumePanel({
  taskId,
  projectId,
  attempt,
}: {
  taskId: string;
  projectId: string;
  attempt: ResumeAttempt | null;
}): React.JSX.Element {
  const theme = useTheme();
  const resuming = attempt?.phase === 'resuming';
  return (
    <View testID="session-resume-panel" style={[styles.panel, { backgroundColor: theme.colors.background, padding: theme.spacing.lg }]}>
      <Stack gap="md" style={styles.content}>
        <Button
          variant="tinted"
          label={resuming ? RESUMING_LABEL : RESUME_LABEL}
          leading={
            resuming ? (
              <StatusSpinner size={GLYPH_SIZE} color={theme.colors.accent} testID="session-resume-spinner" />
            ) : (
              <Play size={GLYPH_SIZE} color={theme.colors.accent} />
            )
          }
          disabled={resuming}
          onPress={() => void resumeTaskSession(taskId, projectId)}
          testID="session-resume-button"
        />
        {attempt?.phase === 'failed' ? (
          <Text variant="caption" color="muted" style={styles.failure} testID="session-resume-error">
            {attempt.message ?? RESUME_FAILED_MESSAGE}
          </Text>
        ) : null}
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  content: {
    alignItems: 'center',
  },
  failure: {
    textAlign: 'center',
  },
});
