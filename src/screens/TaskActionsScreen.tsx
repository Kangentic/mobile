import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import { Icon, Row, Stack, Text, useTheme, type TextColorRole } from '@/components';
import { prStateSummary } from '@/components/board/prChipPresentation';
import { CapabilityError } from '@/channel';
import { PAUSE_WAIT_MS, archiveTask, deleteTaskFromBoard, pauseTaskSession, resumeTaskSession } from '@/connection/actions';
import { findTaskById, isDoneColumn, selectColumnsOrdered, useBoardStore } from '@/state/boardStore';
import { triggerHaptic } from '@/lib/haptics';
import { RESUME_FAILED_MESSAGE, useResumeOffer } from './task/useResumeOffer';

/**
 * Every row here needs both route params. Missing one is a routing defect the
 * user cannot act on, but a row that does NOTHING when tapped is worse than
 * one that admits it: a broken app and a deliberate refusal look identical
 * from the outside, and on the destructive row that is unforgivable.
 */
const MISSING_TASK_CONTEXT = 'Cannot act on this task - close and reopen it';

/** The generic line for a pause the desktop refused without text, or one that never reached it. */
export const PAUSE_FAILED_MESSAGE = 'Pause failed - check the connection';

/** Past PAUSE_WAIT_MS with no paused row. Not a failure: the pause may still land. */
export const PAUSE_UNCONFIRMED_MESSAGE = 'Desktop has not confirmed the pause yet';

function messageForActionError(error: unknown, fallback: string): string {
  return error instanceof CapabilityError ? error.message : error instanceof Error ? error.message : fallback;
}

const HTTPS_SCHEME = 'https://';

/**
 * Only ever hand `https` to the OS opener.
 *
 * `pr_url` comes from the paired desktop, which is trusted, so this is not the
 * load-bearing control - but "trusted source" is exactly the reasoning that
 * turns an opener into a gadget the day some other path can write that column,
 * and the guard costs one comparison. Anything else means the row does not
 * render, rather than rendering a tap that refuses.
 *
 * Deliberately a string comparison rather than `new URL()`, for the reason
 * `isSecureRelayAddress` in `src/pairing/qr.ts` gives: Hermes ships a partial
 * URL implementation and React Native's polyfill situation varies by SDK, so a
 * check whose verdict depends on which parser is present at runtime would be
 * worse than the comparison it replaced. Jest runs on Node's complete URL, so
 * that difference would never have shown up in a test.
 */
function httpsPrUrl(prUrl: string | null): string | null {
  if (prUrl === null) return null;
  // The scheme is case-insensitive, the rest of the URL is not.
  if (!prUrl.toLowerCase().startsWith(HTTPS_SCHEME)) return null;
  return prUrl.length > HTTPS_SCHEME.length ? prUrl : null;
}

/**
 * The long-press hub for a task card, as a native form sheet route: the full
 * task lifecycle from the phone.
 *
 * Move and Edit REPLACE this route rather than pushing over it, so dismissing
 * the sheet they open returns to the board instead of to a menu the user has
 * already finished with.
 *
 * Delete is a two-step in-sheet confirm (tap arms it, a second tap within the
 * window fires) rather than a system Alert, so it stays themed and
 * Maestro-testable. Deleting also kills the task's live desktop session.
 */
export function TaskActionsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { taskId, projectId } = useLocalSearchParams<{ taskId?: string; projectId?: string }>();

  const task = useBoardStore((state) => (taskId ? (findTaskById(state, taskId)?.task ?? null) : null));
  const board = useBoardStore((state) => (projectId ? (state.boardsByProjectId[projectId] ?? null) : null));
  // Archive is a move into the board's done-role column, so it needs one.
  const archiveAvailable = useMemo(
    () => (board ? selectColumnsOrdered(board).some(isDoneColumn) : false),
    [board],
  );

  const [actionInFlight, setActionInFlight] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  // Design review round 2, decision B: the desktop card's right-click menu
  // has no Resume, so this row is the phone's one addition to the hub, shown
  // only where the session view would offer Resume.
  const resumeOffer = useResumeOffer(taskId ?? null, task?.session_id ?? null);
  // A Pause sent from this sheet and not yet settled. The sheet stays open on
  // "Pausing agent..." until the task's row reads paused, because the desktop
  // answers on ACCEPT while the agent shuts down behind it (protocol 0.18.0).
  const [pausing, setPausing] = useState(false);
  const busy = actionInFlight || pausing;

  /**
   * Resume, Archive and Delete each close the sheet only after an await, and
   * the user can swipe the sheet away while that request is in flight. A late
   * `router.back()` would then pop whatever screen is on top by then (the
   * session screen, say), so it only fires while this sheet is still mounted.
   */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const closeIfStillOpen = useCallback(() => {
    if (mountedRef.current) router.back();
  }, [router]);

  // The one non-mutating row in the sheet, and the only place the phone can
  // act on the PR the card's readiness chip is talking about.
  const prUrl = httpsPrUrl(task?.pr_url ?? null);
  const prCaption = useMemo(() => {
    if (!task) return null;
    const state = prStateSummary(task.pr_state, task.pr_merge_readiness);
    return task.pr_number === null ? state : `#${task.pr_number} - ${state}`;
  }, [task]);

  /**
   * `Linking.openURL` hands the URL to the OS default handler, which is what
   * lets a github.com PR open in the GitHub app through Android App Links /
   * iOS Universal Links. An in-app browser (expo-web-browser) would keep it in
   * a web view and deliberately skip that handoff.
   */
  const onViewPr = useCallback(() => {
    if (prUrl === null) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    setErrorMessage(null);
    void Linking.openURL(prUrl).catch((error: unknown) =>
      setErrorMessage(messageForActionError(error, 'Could not open the pull request')),
    );
  }, [prUrl]);

  /**
   * As the desktop's menu item does, closes and resumes, but only once the
   * desktop has ACCEPTED the start: a refusal (a column that blocks Resume, a
   * lost connection) stays in the sheet, where the user tapped. The resume
   * itself then runs on the desktop and reaches the card as its usual events.
   */
  const onResume = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    setActionInFlight(true);
    setErrorMessage(null);
    void resumeTaskSession(taskId, projectId).then((attempt) => {
      setActionInFlight(false);
      if (attempt.phase === 'failed') {
        setErrorMessage(attempt.message ?? RESUME_FAILED_MESSAGE);
        return;
      }
      closeIfStillOpen();
    });
  }, [taskId, projectId, closeIfStillOpen]);

  /**
   * The desktop task header's Pause, which the desktop card's menu does not
   * carry either: a second phone addition beside Resume, offered only where
   * the row's `pausable` promises the desktop's own Pause path. A refusal
   * stays in the sheet with the desktop's text; anything else waits for the
   * paused row (see the settle effect below).
   */
  const onPause = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    setPausing(true);
    setErrorMessage(null);
    void pauseTaskSession(taskId, projectId).then((outcome) => {
      if (outcome.kind !== 'refused') return;
      setPausing(false);
      setErrorMessage(outcome.message ?? PAUSE_FAILED_MESSAGE);
    });
  }, [taskId, projectId]);

  // The pause settles on the BOARD ROW, never on the verb's answer: the row
  // reading `paused: true`, or the row leaving the store, which is what the
  // Agents feed's sessions projection does with a paused task that offers no
  // Resume (one in Done, say). Bounded from the tap, so a pause the desktop
  // never confirms re-enables the row instead of holding the sheet forever.
  const taskGone = task === null;
  const taskPaused = task?.paused === true;
  useEffect(() => {
    if (!pausing) return;
    if (taskGone || taskPaused) {
      // Closing unmounts the sheet, so `pausing` needs no reset here.
      closeIfStillOpen();
      return;
    }
    const waitBound = setTimeout(() => {
      setPausing(false);
      setErrorMessage(PAUSE_UNCONFIRMED_MESSAGE);
    }, PAUSE_WAIT_MS);
    return () => clearTimeout(waitBound);
  }, [pausing, taskGone, taskPaused, closeIfStillOpen]);

  const onMove = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    router.replace({ pathname: '/move-task', params: { taskId, projectId } });
  }, [taskId, projectId, router]);

  const onEdit = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    router.replace({ pathname: '/edit-task', params: { taskId, projectId } });
  }, [taskId, projectId, router]);

  const onArchive = useCallback(() => {
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    setActionInFlight(true);
    setErrorMessage(null);
    void archiveTask({ projectId, taskId })
      .then(() => closeIfStillOpen())
      .catch((error: unknown) => setErrorMessage(messageForActionError(error, 'Archive failed - check the connection')))
      .finally(() => setActionInFlight(false));
  }, [taskId, projectId, closeIfStillOpen]);

  /**
   * Two-step confirm: the first tap arms, the second fires. The armed state
   * ends when the user acts or the sheet goes away - never on a clock.
   *
   * It used to relax after ten seconds, and that deadline was invisible. The
   * row reverted to "Delete task" with no signal, so a confirm tap arriving a
   * beat late was silently reinterpreted as a FRESH arm: the user saw the
   * same words they had just tapped, no delete, and no reason, with no way to
   * tell a missed deadline from a broken app. It punished exactly the user
   * who stopped to read the consequence line. The expiry never did the job it
   * claimed either - an accidental rapid double-tap fires the delete whatever
   * the window is, because the guard is the second tap, not the clock - so
   * dropping it costs nothing that was ever there.
   */
  const onDeletePress = useCallback(() => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleteArmed(false);
    if (!taskId || !projectId) {
      setErrorMessage(MISSING_TASK_CONTEXT);
      return;
    }
    setActionInFlight(true);
    setErrorMessage(null);
    void deleteTaskFromBoard({ projectId, taskId })
      .then(() => {
        triggerHaptic('destructiveConfirmed');
        closeIfStillOpen();
      })
      .catch((error: unknown) => setErrorMessage(messageForActionError(error, 'Delete failed - check the connection')))
      .finally(() => setActionInFlight(false));
  }, [deleteArmed, taskId, projectId, closeIfStillOpen]);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.xl + insets.bottom,
        },
      ]}
      testID="task-actions-sheet"
    >
      <Stack gap="xs">
        <Text variant="title" numberOfLines={2}>
          {task ? task.title : 'Task'}
        </Text>
        {resumeOffer.offered ? (
          <ActionRow
            label="Resume session"
            iconName="resume"
            onPress={onResume}
            disabled={busy || resumeOffer.attempt?.phase === 'resuming'}
            testID="task-action-resume"
          />
        ) : null}
        {/* Never beside Resume: `pausable` is never true while `paused` is.
            Kept while a pause is pending, so the row does not vanish under
            the user the moment the desktop starts shutting the agent down. */}
        {task?.pausable === true || pausing ? (
          <ActionRow
            label={pausing ? 'Pausing agent...' : 'Pause session'}
            iconName="pause"
            onPress={onPause}
            disabled={busy}
            testID="task-action-pause"
          />
        ) : null}
        {prUrl !== null ? (
          <ActionRow
            label="View pull request"
            iconName="git-pull-request"
            onPress={onViewPr}
            disabled={busy}
            caption={prCaption}
            testID="task-action-view-pr"
          />
        ) : null}
        <ActionRow
          label="Move to column"
          iconName="swap-horizontal"
          onPress={onMove}
          disabled={busy}
          testID="task-action-move"
        />
        <ActionRow
          label="Edit task"
          iconName="create"
          onPress={onEdit}
          disabled={busy}
          testID="task-action-edit"
        />
        <ActionRow
          label="Archive"
          iconName="archive"
          onPress={onArchive}
          disabled={busy || !archiveAvailable}
          caption={archiveAvailable ? null : 'No Done column on this board'}
          testID="task-action-archive"
        />
        <ActionRow
          label={deleteArmed ? 'Tap again to delete' : 'Delete task'}
          iconName="trash"
          color="danger"
          onPress={onDeletePress}
          disabled={busy}
          caption={deleteArmed ? 'Removes the task and stops its session on your desktop' : null}
          testID={deleteArmed ? 'task-action-delete-confirm' : 'task-action-delete'}
        />
        {errorMessage ? (
          <Text variant="caption" color="danger" testID="task-action-error">
            {errorMessage}
          </Text>
        ) : null}
      </Stack>
    </View>
  );
}

function ActionRow({
  label,
  iconName,
  onPress,
  disabled,
  testID,
  color = 'primary',
  caption = null,
}: {
  label: string;
  iconName: React.ComponentProps<typeof Icon>['name'];
  onPress: () => void;
  disabled: boolean;
  testID: string;
  color?: TextColorRole;
  caption?: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[
        styles.actionRow,
        {
          minHeight: theme.minTouchSize,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radii.md,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Row gap="sm" style={styles.actionRowContent}>
        <Icon name={iconName} color={color === 'danger' ? 'danger' : 'secondary'} size={20} />
        <Stack gap="xs" style={styles.flex}>
          <Text variant="body" color={color}>
            {label}
          </Text>
          {caption ? (
            <Text variant="caption" color="muted">
              {caption}
            </Text>
          ) : null}
        </Stack>
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    justifyContent: 'center',
    paddingVertical: 8,
  },
  actionRowContent: {
    alignItems: 'center',
  },
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  flex: {
    flex: 1,
  },
});
