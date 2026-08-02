import { describe, expect, it } from 'vitest';
import {
  DESKTOP_PARK_GRID,
  INITIAL_GRID_HOLD_STATE,
  isDesktopParkGrid,
  reduceGridHold,
  type GridHoldEvent,
  type GridHoldState,
} from '@/terminal/gridHold';

/**
 * The fit-to-phone hold decision, transition by transition. The mirror model
 * is unchanged whenever a desktop surface holds the terminal; the phone
 * requests its own grid ONLY when the desktop reports the park sentinel
 * (120x30, no desktop surface showing the session), and the desktop always
 * wins it back.
 */

const PREFERRED = { cols: 48, rows: 36 };
const DETAIL_GRID = { cols: 210, rows: 48 };

function drive(events: GridHoldEvent[], from: GridHoldState = INITIAL_GRID_HOLD_STATE) {
  let state = from;
  const commands = [];
  for (const event of events) {
    const transition = reduceGridHold(state, event);
    state = transition.state;
    if (transition.command) commands.push(transition.command);
  }
  return { state, commands };
}

describe('requesting', () => {
  it('requests the preferred grid when parked dims arrive with the gate open', () => {
    const { state, commands } = drive([
      { type: 'preferred-grid-measured', grid: PREFERRED, dims: null, canRequest: true },
      { type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: true },
    ]);
    expect(state.phase).toBe('requested');
    expect(commands).toEqual([{ type: 'send-resize', dims: PREFERRED }]);
  });

  it('requests when the measurement lands after the parked dims', () => {
    const { state, commands } = drive([
      { type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: true },
      { type: 'preferred-grid-measured', grid: PREFERRED, dims: DESKTOP_PARK_GRID, canRequest: true },
    ]);
    expect(state.phase).toBe('requested');
    expect(commands).toEqual([{ type: 'send-resize', dims: PREFERRED }]);
  });

  it('requests on the gate reopening (lens switch or keyboard hide)', () => {
    const { state, commands } = drive([
      { type: 'preferred-grid-measured', grid: PREFERRED, dims: DESKTOP_PARK_GRID, canRequest: false },
      { type: 'request-gate-opened', dims: DESKTOP_PARK_GRID },
    ]);
    expect(state.phase).toBe('requested');
    expect(commands).toEqual([{ type: 'send-resize', dims: PREFERRED }]);
  });

  /**
   * The park-detection guard. THE load-bearing comparison of the whole
   * feature: any grid that is not exactly the park sentinel means a desktop
   * surface may be showing the session, and the mirror must not touch it.
   */
  it('never requests while the desktop reports a non-park grid', () => {
    const { state, commands } = drive([
      { type: 'preferred-grid-measured', grid: PREFERRED, dims: DETAIL_GRID, canRequest: true },
      { type: 'dims-reported', dims: DETAIL_GRID, canRequest: true },
      { type: 'request-gate-opened', dims: DETAIL_GRID },
    ]);
    expect(state.phase).toBe('mirror');
    expect(commands).toEqual([]);
  });

  it('the sentinel is exact on both axes (a 120-col desktop grid at another height is not the park)', () => {
    expect(isDesktopParkGrid({ cols: 120, rows: 30 })).toBe(true);
    expect(isDesktopParkGrid({ cols: 120, rows: 31 })).toBe(false);
    expect(isDesktopParkGrid({ cols: 121, rows: 30 })).toBe(false);
    expect(isDesktopParkGrid(null)).toBe(false);
  });

  it('never requests while the gate is closed (keyboard up or lens inactive)', () => {
    const { state, commands } = drive([
      { type: 'preferred-grid-measured', grid: PREFERRED, dims: DESKTOP_PARK_GRID, canRequest: false },
      { type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: false },
    ]);
    expect(state.phase).toBe('mirror');
    expect(commands).toEqual([]);
  });

  it('never requests without a measurement, and never requests the park itself', () => {
    const unmeasured = drive([{ type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: true }]);
    expect(unmeasured.commands).toEqual([]);

    // A degenerate measurement equal to the park would resize to what is
    // already there and hold it, blocking the desktop's own restore for
    // nothing.
    const parkPreferred = drive([
      { type: 'preferred-grid-measured', grid: { ...DESKTOP_PARK_GRID }, dims: DESKTOP_PARK_GRID, canRequest: true },
    ]);
    expect(parkPreferred.commands).toEqual([]);
  });
});

describe('holding and takeover', () => {
  const requested = drive([
    { type: 'preferred-grid-measured', grid: PREFERRED, dims: null, canRequest: true },
    { type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: true },
  ]).state;

  it('enters holding when the granted grid echoes back', () => {
    const { state, commands } = drive([{ type: 'dims-reported', dims: PREFERRED, canRequest: true }], requested);
    expect(state.phase).toBe('holding');
    expect(commands).toEqual([]);
  });

  it('stays through a park echo racing the request', () => {
    const { state, commands } = drive([{ type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: true }], requested);
    expect(state.phase).toBe('requested');
    expect(commands).toEqual([]);
  });

  /**
   * Desktop takeover: any other grid means a desktop surface took the
   * session. The release is REQUIRED, not politeness - the desktop's size
   * guard stays armed until release, an armed guard blocks the park, and a
   * blocked park means the phone would never see park dims again: the
   * deadlock that would otherwise strand the phone mirroring forever.
   */
  it('reverts to mirror AND releases when the desktop takes the grid', () => {
    const held = drive([{ type: 'dims-reported', dims: PREFERRED, canRequest: true }], requested).state;
    const { state, commands } = drive([{ type: 'dims-reported', dims: DETAIL_GRID, canRequest: true }], held);
    expect(state.phase).toBe('mirror');
    expect(state.requestedGrid).toBeNull();
    expect(commands).toEqual([{ type: 'send-release' }]);
  });

  it('records but never acts on a new measurement while holding (no keyboard thrash)', () => {
    const held = drive([{ type: 'dims-reported', dims: PREFERRED, canRequest: true }], requested).state;
    const squashed = { cols: 48, rows: 20 };
    const { state, commands } = drive(
      [{ type: 'preferred-grid-measured', grid: squashed, dims: PREFERRED, canRequest: true }],
      held,
    );
    expect(state.phase).toBe('holding');
    expect(state.preferredGrid).toEqual(squashed);
    expect(commands).toEqual([]);
  });
});

describe('releasing', () => {
  it('releases from requested or holding, and re-requests on the next park sighting', () => {
    const held = drive([
      { type: 'preferred-grid-measured', grid: PREFERRED, dims: null, canRequest: true },
      { type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: true },
      { type: 'dims-reported', dims: PREFERRED, canRequest: true },
    ]).state;

    const released = drive([{ type: 'releasing' }], held);
    expect(released.state.phase).toBe('mirror');
    expect(released.commands).toEqual([{ type: 'send-release' }]);

    // The desktop restores, re-parks, and the next visit requests again.
    const revisit = drive([{ type: 'dims-reported', dims: DESKTOP_PARK_GRID, canRequest: true }], released.state);
    expect(revisit.commands).toEqual([{ type: 'send-resize', dims: PREFERRED }]);
  });

  it('a release from mirror sends nothing (no redundant verb traffic)', () => {
    const { state, commands } = drive([{ type: 'releasing' }]);
    expect(state.phase).toBe('mirror');
    expect(commands).toEqual([]);
  });
});
