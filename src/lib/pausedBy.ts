import { PAUSED_BY_WIRE_VALUES, type PausedByWire } from '@kangentic/protocol';

/** A paused card's footer words, and the one line under Resume session (null for none). */
interface PausedByCopy {
  footer: string;
  resumeNote: string | null;
}

const PAUSED_LABEL = 'Paused';

/**
 * Who paused a task (protocol 0.29.0's `BoardTaskWire.paused_by`), in the
 * desktop's words (kangentic 4fe1dfbdb: `task-card-view.tsx`'s `PendingFooter`
 * and `TaskDetailBody.tsx`'s `pauseNote`). It picks words and nothing else:
 * whether opening the task resumes it is the desktop's call, never this field's.
 *
 * - `idle`: the idle timeout paused an agent that was waiting on the person.
 *   The card says so, and the line under Resume says only what happened,
 *   because an open can still skip the resume.
 * - `held`: a person paused it (the desktop's Pause or the phone's). The card
 *   keeps "Paused", and the line says it waits for Resume.
 * - `system`: the desktop paused it on its own (a quit, a column move, a
 *   settings restart). "Paused", and no line.
 *
 * The wire carries a widened string, so a value this phone does not know reads
 * as absent: "Paused" and no line, as an older desktop that sends no field
 * reads. A blocked start (`start_blocked_reason`) replaces all of these words;
 * its callers check that first.
 */
const PAUSED_BY_COPY: Record<PausedByWire, PausedByCopy> = {
  idle: { footer: 'Paused while idle', resumeNote: 'Paused while idle.' },
  held: { footer: PAUSED_LABEL, resumeNote: 'Stays paused until resumed.' },
  system: { footer: PAUSED_LABEL, resumeNote: null },
};

function isPausedByWire(value: string): value is PausedByWire {
  return (PAUSED_BY_WIRE_VALUES as readonly string[]).includes(value);
}

function knownPausedBy(pausedBy: string | null | undefined): PausedByWire | null {
  if (pausedBy === null || pausedBy === undefined) return null;
  return isPausedByWire(pausedBy) ? pausedBy : null;
}

/** The paused card's footer words: "Paused while idle" for the idle timeout's pause, else "Paused". */
export function pausedFooterLabel(pausedBy: string | null | undefined): string {
  const known = knownPausedBy(pausedBy);
  return known === null ? PAUSED_LABEL : PAUSED_BY_COPY[known].footer;
}

/** The one line under Resume session, or null when the desktop draws none. */
export function resumePauseNote(pausedBy: string | null | undefined): string | null {
  const known = knownPausedBy(pausedBy);
  return known === null ? null : PAUSED_BY_COPY[known].resumeNote;
}
