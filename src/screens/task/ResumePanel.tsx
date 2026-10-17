import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Play, Workflow } from 'lucide-react-native';
import { Button, StatusSpinner, Stack, Text, useTheme } from '@/components';
import { resumeTaskSession } from '@/connection/actions';
import type { ResumeAttempt } from '@/state/resumeStore';
import { RESUME_FAILED_MESSAGE, type ResumeOffer } from './useResumeOffer';

/** The desktop's wording, verbatim (TaskDetailBody.tsx). */
const RESUME_LABEL = 'Resume session';
const RESUMING_LABEL = 'Resuming agent...';
/** The phone's word for the desktop menu's Open workflow, as the long-press sheet's View pull request is worded. */
const VIEW_WORKFLOW_LABEL = 'View workflow';
const GLYPH_SIZE = 16;

/**
 * What the terminal lens shows for a paused session: the desktop task view's
 * body for a suspended task (TaskDetailBody.tsx), a "Resume session" button
 * centred where the terminal would be. While the resume runs it reads
 * "Resuming agent..." with a spinner and cannot be pressed again; if it fails,
 * the desktop's line appears under it (the desktop's own refusal text when it
 * sent one) and the button is live again for a retry.
 *
 * A task of a PAUSED WORKFLOW (protocol 0.21.0) shows a single "View workflow"
 * button instead, and nothing else (design screen 5): the desktop refuses to
 * resume one task of a paused workflow, so the button takes the user to the
 * workflow view, the one place a workflow resumes.
 *
 * Drawn over the terminal pane rather than in place of it: the xterm WebView
 * must never unmount, and the opaque panel hides it exactly as the desktop's
 * body hides its terminal.
 */
export function ResumePanel({
  taskId,
  projectId,
  attempt,
  pausedWorkflow = null,
}: {
  taskId: string;
  projectId: string;
  attempt: ResumeAttempt | null;
  pausedWorkflow?: ResumeOffer['pausedWorkflow'];
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const resuming = attempt?.phase === 'resuming';
  return (
    <View testID="session-resume-panel" style={[styles.panel, { backgroundColor: theme.colors.background, padding: theme.spacing.lg }]}>
      {pausedWorkflow !== null ? (
        <Button
          variant="tinted"
          label={VIEW_WORKFLOW_LABEL}
          leading={<Workflow size={GLYPH_SIZE} color={theme.colors.accent} />}
          onPress={() =>
            router.push({
              pathname: '/workflow',
              params: { workflowId: pausedWorkflow.workflowId, projectId: pausedWorkflow.homeProjectId },
            })
          }
          testID="session-view-workflow"
        />
      ) : (
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
      )}
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
