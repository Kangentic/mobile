import { useMemo } from 'react';
import * as Linking from 'expo-linking';
import { findArchivedTaskById, findTaskById, useBoardStore } from '@/state/boardStore';
import { openableArtifacts, type TaskArtifactLink } from '@/lib/taskArtifacts';

/**
 * A task's links (protocol 0.28.0), the ones the phone may open, from its row
 * wherever the phone holds it: a live board, or a project's archive for a
 * completed task (the archived page carries them too). Empty for a task with
 * none, and from a desktop older than 0.28.0.
 *
 * Selects the stored arrays and derives from them: `findArchivedTaskById`
 * builds a fresh object per call, which as a selector would re-render forever.
 */
export function useTaskArtifactLinks(taskId: string | null): TaskArtifactLink[] {
  const liveArtifacts = useBoardStore((state) => (taskId !== null ? (findTaskById(state, taskId)?.task.artifacts ?? null) : null));
  const archivedByProjectId = useBoardStore((state) => state.archivedByProjectId);
  const archivedArtifacts = useMemo(
    () => (taskId !== null && liveArtifacts === null ? (findArchivedTaskById({ archivedByProjectId }, taskId)?.task.artifacts ?? null) : null),
    [archivedByProjectId, taskId, liveArtifacts],
  );
  return useMemo(() => openableArtifacts(liveArtifacts ?? archivedArtifacts), [liveArtifacts, archivedArtifacts]);
}

/**
 * Opens a task's link in the OS handler, as Chat's links and the PR row do:
 * `Linking.openURL`, so a figma.com or claude.ai link can open in its own app
 * through Universal Links / App Links rather than an in-app web view. The link
 * has already passed `httpsUrlOrNull` (`openableArtifacts`). Rejects when the OS
 * refuses it, so a surface with an error line can say so.
 */
export function openArtifactLink(link: TaskArtifactLink): Promise<void> {
  return Linking.openURL(link.url).then(() => undefined);
}

/** The line a surface shows when the OS refuses a link. */
export const ARTIFACT_OPEN_FAILED_MESSAGE = 'Could not open the link';
