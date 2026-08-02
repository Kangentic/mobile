/**
 * The fit-to-phone hold decision, as a pure reducer (decision change
 * 2026-08-02; docs/terminal-ownership-design.md records why the parked case
 * reopened the narrow resize path while ownership stays shelved).
 *
 * The mirror model is unchanged whenever a desktop surface holds the
 * terminal: the phone renders the desktop's exact grid and never reshapes
 * it. But a session the desktop has PARKED (no desktop surface shows it;
 * the desktop rests it at 120x30) has no desktop reader to disturb, and a
 * 120x30 mirror fills a phone's portrait height at a third of its width.
 * Only there does the phone request its own measured grid, and the desktop
 * always wins it back: any desktop-shaped dims event reverts the phone to
 * the mirror AND releases the hold.
 *
 * That release-on-revert is REQUIRED, not politeness: the desktop's size
 * guard stays armed from the phone's first resize until release, an armed
 * guard blocks the park, and a blocked park means the phone would never see
 * park dims again - permanently stuck mirroring whatever the desktop last
 * had, with no cue to re-request (the deadlock this reducer exists to make
 * impossible).
 */
import type { TerminalDimensionsWire } from '@kangentic/protocol';

/**
 * The desktop's resting grid, the sentinel that means "no desktop surface
 * holds this session". COUPLED to the desktop's spawn defaults
 * (DEFAULT_PTY_COLS/DEFAULT_PTY_ROWS in the kangentic repo's
 * session-spawn-flow.ts, which the resting park reuses): if the desktop
 * park size ever changes, update this constant in the same change. A real
 * desktop window at exactly 120x30 is an accepted, documented edge - the
 * phone would briefly take its grid, and any desktop interaction refits
 * and wins it back.
 */
export const DESKTOP_PARK_GRID: TerminalDimensionsWire = { cols: 120, rows: 30 };

export type GridHoldPhase = 'mirror' | 'requested' | 'holding';

export interface GridHoldState {
  phase: GridHoldPhase;
  /** The page's latest measured full-portrait grid; null until it reports. */
  preferredGrid: TerminalDimensionsWire | null;
  /** The grid the phone asked the desktop for; null while in mirror. */
  requestedGrid: TerminalDimensionsWire | null;
}

export const INITIAL_GRID_HOLD_STATE: GridHoldState = {
  phase: 'mirror',
  preferredGrid: null,
  requestedGrid: null,
};

export type GridHoldEvent =
  /**
   * The desktop reported the session's PTY dims (init snapshot or resize
   * event). `canRequest` is "the terminal lens is visible AND the soft
   * keyboard is hidden": a request fired with the keyboard up would measure
   * a half-height viewport and hold a squashed grid that nothing re-fits
   * until release (re-measures while holding are deliberately ignored).
   */
  | { type: 'dims-reported'; dims: TerminalDimensionsWire; canRequest: boolean }
  /** The page measured its preferred full-portrait grid after a settled fit. */
  | { type: 'preferred-grid-measured'; grid: TerminalDimensionsWire; dims: TerminalDimensionsWire | null; canRequest: boolean }
  /**
   * The request gate reopened (lens became the visible segment, or the soft
   * keyboard hid): re-evaluate whether to request. Needed as its own event
   * because a keyboard close usually re-measures the SAME preferred grid,
   * which the page dedupes into no report at all.
   */
  | { type: 'request-gate-opened'; dims: TerminalDimensionsWire | null }
  /** The hold must end: pane unmount (screen close) or app background. */
  | { type: 'releasing' };

export type GridHoldCommand =
  | { type: 'send-resize'; dims: TerminalDimensionsWire }
  | { type: 'send-release' };

export interface GridHoldTransition {
  state: GridHoldState;
  command: GridHoldCommand | null;
}

function dimsEqual(a: TerminalDimensionsWire | null, b: TerminalDimensionsWire | null): boolean {
  return a !== null && b !== null && a.cols === b.cols && a.rows === b.rows;
}

export function isDesktopParkGrid(dims: TerminalDimensionsWire | null): boolean {
  return dimsEqual(dims, DESKTOP_PARK_GRID);
}

/**
 * Request only when every gate is open: the lens is visible with no soft
 * keyboard up, the desktop reports the park sentinel, the page has measured
 * a preferred grid, and no request is already in flight or held.
 */
function maybeRequest(state: GridHoldState, dims: TerminalDimensionsWire | null, canRequest: boolean): GridHoldTransition {
  if (
    state.phase === 'mirror' &&
    canRequest &&
    isDesktopParkGrid(dims) &&
    state.preferredGrid !== null &&
    !dimsEqual(state.preferredGrid, DESKTOP_PARK_GRID)
  ) {
    return {
      state: { ...state, phase: 'requested', requestedGrid: state.preferredGrid },
      command: { type: 'send-resize', dims: state.preferredGrid },
    };
  }
  return { state, command: null };
}

export function reduceGridHold(state: GridHoldState, event: GridHoldEvent): GridHoldTransition {
  switch (event.type) {
    case 'dims-reported': {
      if (state.phase === 'mirror') return maybeRequest(state, event.dims, event.canRequest);
      // Our own grid arrived: the request landed (or is still ours).
      if (dimsEqual(event.dims, state.requestedGrid)) {
        return { state: { ...state, phase: 'holding' }, command: null };
      }
      // Park dims while requested/holding: an event echo or a re-park racing
      // our resize. Not a desktop takeover - stay and let our grid land.
      if (isDesktopParkGrid(event.dims)) return { state, command: null };
      // Any OTHER grid is a desktop surface taking the session. Revert to
      // the mirror and RELEASE (see the file header for why the release is
      // load-bearing). The desktop's restore no-ops - it just resized - and
      // the disarm is what re-enables the park after that surface closes.
      return {
        state: { ...state, phase: 'mirror', requestedGrid: null },
        command: { type: 'send-release' },
      };
    }
    case 'preferred-grid-measured': {
      // While requested/holding the measurement is recorded but never acted
      // on: the keyboard halves the viewport and would otherwise thrash a
      // resize+reflow round trip per open/close. The held grid stays until
      // release; the next request uses the newest measurement.
      const measured: GridHoldState = { ...state, preferredGrid: event.grid };
      if (state.phase !== 'mirror') return { state: measured, command: null };
      return maybeRequest(measured, event.dims, event.canRequest);
    }
    case 'request-gate-opened':
      return maybeRequest(state, event.dims, true);
    case 'releasing': {
      if (state.phase === 'mirror') return { state, command: null };
      return {
        state: { ...state, phase: 'mirror', requestedGrid: null },
        command: { type: 'send-release' },
      };
    }
  }
}
