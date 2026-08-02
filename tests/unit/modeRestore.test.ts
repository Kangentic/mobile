import { describe, expect, it } from 'vitest';
import { buildModeRestoreSequence, type TerminalStickyModes } from '../../src/terminal/modeRestore';

const ESCAPE = '\x1b';

function modes(overrides: Partial<TerminalStickyModes> = {}): TerminalStickyModes {
  return {
    applicationCursorKeys: false,
    mouseTrackingMode: 'none',
    mouseEncoding: 'DEFAULT',
    alternateBuffer: false,
    ...overrides,
  };
}

describe('buildModeRestoreSequence', () => {
  /**
   * The state measured live on a Pixel while history scrolling was silent: the
   * desktop PTY in the alternate screen with SGR-encoded mouse reporting, and
   * the phone's terminal rebuilt from a ring that had evicted every one of
   * those DECSETs.
   */
  it('restores the full fullscreen-TUI mode set', () => {
    const sequence = buildModeRestoreSequence(
      modes({ alternateBuffer: true, mouseTrackingMode: 'any', mouseEncoding: 'SGR' }),
    );
    expect(sequence).toBe(`${ESCAPE}[?1049h${ESCAPE}[?1003h${ESCAPE}[?1006h`);
  });

  /**
   * The alternate screen has to come FIRST: everything replayed after it is
   * cursor-addressed for that buffer, and writing those frames into the normal
   * buffer is what put the mirror in the wrong state to begin with.
   */
  it('enters the alternate screen before anything else', () => {
    const sequence = buildModeRestoreSequence(
      modes({ alternateBuffer: true, mouseTrackingMode: 'vt200', applicationCursorKeys: true }),
    );
    expect(sequence.indexOf('1049')).toBeLessThan(sequence.indexOf('1000'));
    expect(sequence.indexOf('1049')).toBeLessThan(sequence.indexOf('?1h'));
  });

  it('maps each mouse tracking level to its own DECSET', () => {
    const parameterByMode: Record<string, string> = { x10: '9', vt200: '1000', drag: '1002', any: '1003' };
    for (const [mouseTrackingMode, parameter] of Object.entries(parameterByMode)) {
      expect(buildModeRestoreSequence(modes({ mouseTrackingMode }))).toBe(`${ESCAPE}[?${parameter}h`);
    }
  });

  /**
   * Nothing to restore must produce NOTHING, not a partial reset: this runs
   * ahead of every seed, including the first one on a plain shell that was
   * never in the alternate screen at all.
   */
  it('emits nothing when there is nothing to restore', () => {
    expect(buildModeRestoreSequence(null)).toBe('');
    expect(buildModeRestoreSequence(modes())).toBe('');
    expect(buildModeRestoreSequence(modes({ mouseTrackingMode: 'unrecognized-future-mode' }))).toBe('');
  });

  /** The default encoding IS the reset state, so re-asserting it is noise. */
  it('restores the SGR encoding only alongside tracking, and never the default one', () => {
    expect(buildModeRestoreSequence(modes({ mouseTrackingMode: 'any', mouseEncoding: 'DEFAULT' }))).toBe(
      `${ESCAPE}[?1003h`,
    );
    // SGR without tracking would enable an encoding for reports nobody asked for.
    expect(buildModeRestoreSequence(modes({ mouseTrackingMode: 'none', mouseEncoding: 'SGR' }))).toBe('');
  });

  it('restores application cursor keys on their own', () => {
    expect(buildModeRestoreSequence(modes({ applicationCursorKeys: true }))).toBe(`${ESCAPE}[?1h`);
  });
});
