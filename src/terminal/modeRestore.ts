/**
 * Rebuilds the sticky VT modes a replayed seed cannot carry.
 *
 * A fullscreen TUI sets its modes ONCE at startup - alternate screen, mouse
 * reporting, the SGR encoding for those reports, application cursor keys - and
 * never sends them again. The phone's terminal feed is a RING holding only a
 * tail (measured live at 124KB against a 626KB desktop scrollback), so those
 * bytes are evicted early in any real session. Every re-init afterwards - a tab
 * switch, a session swap, returning from the background, a fresh subscribe -
 * replays a stream that begins mid-frame, and the terminal comes up in a
 * DIFFERENT state than the desktop PTY it is mirroring.
 *
 * Measured on device: the desktop PTY in the alternate screen with mouse
 * reporting on, while the phone's xterm sat in the normal buffer reporting
 * mouseTrackingMode 'none'. History scrolling picked local viewport scrolling
 * as a result, which moves a buffer with no scrollback and sends nothing, so
 * scrolling went silent and stayed silent until something happened to re-assert
 * the modes.
 *
 * The modes come from the WebView's own VT parser rather than from scanning the
 * byte stream for DECSET sequences: a sequence can be split across two chunks,
 * and this ring holds hundreds of them.
 */
import { ESCAPE } from './keySequences';

/** Sticky modes the WebView reports; the shape stored per session. */
export interface TerminalStickyModes {
  applicationCursorKeys: boolean;
  /** xterm's IModes value: 'none' | 'x10' | 'vt200' | 'drag' | 'any'. */
  mouseTrackingMode: string;
  /** xterm's active mouse encoding, e.g. 'DEFAULT' or 'SGR'. */
  mouseEncoding: string;
  alternateBuffer: boolean;
}

/** DECSET parameter that turns on each mouse tracking level. */
const MOUSE_TRACKING_PARAMETERS_BY_MODE: Record<string, string> = {
  x10: '9',
  vt200: '1000',
  drag: '1002',
  any: '1003',
};

/**
 * The DECSET sequence that puts a freshly created terminal back into `modes`,
 * to be written AHEAD of the replayed scrollback.
 *
 * Order matters: the alternate screen comes first, so every cursor-addressed
 * frame in the seed that follows lands in the buffer it was drawn for.
 *
 * Returns '' when there is nothing to restore, which is also the honest answer
 * before the phone has ever observed the modes - if it connected after the
 * desktop's own snapshot had already truncated past them, there is nothing to
 * remember. That case self-heals the moment the TUI re-asserts anything.
 */
export function buildModeRestoreSequence(modes: TerminalStickyModes | null): string {
  if (modes === null) return '';
  let sequence = '';
  if (modes.alternateBuffer) sequence += `${ESCAPE}[?1049h`;
  const trackingParameter = MOUSE_TRACKING_PARAMETERS_BY_MODE[modes.mouseTrackingMode];
  if (trackingParameter !== undefined) sequence += `${ESCAPE}[?${trackingParameter}h`;
  // Only meaningful alongside tracking, and only SGR is worth restoring: the
  // default encoding IS the reset state, so re-asserting it would be a no-op.
  if (trackingParameter !== undefined && modes.mouseEncoding === 'SGR') sequence += `${ESCAPE}[?1006h`;
  if (modes.applicationCursorKeys) sequence += `${ESCAPE}[?1h`;
  return sequence;
}
