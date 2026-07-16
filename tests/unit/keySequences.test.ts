import { describe, expect, it } from 'vitest';
import { arrowKeySequence, CTRL_C, ENTER, ESCAPE, SLASH, TAB } from '@/terminal/keySequences';

describe('key sequence constants', () => {
  it('match the raw PTY bytes Claude Code expects', () => {
    expect(ESCAPE).toBe('\x1b');
    expect(TAB).toBe('\t');
    expect(ENTER).toBe('\r');
    expect(CTRL_C).toBe('\x03');
    expect(SLASH).toBe('/');
  });
});

describe('arrowKeySequence', () => {
  it('returns CSI variants by default', () => {
    expect(arrowKeySequence('up')).toBe('\x1b[A');
    expect(arrowKeySequence('down')).toBe('\x1b[B');
    expect(arrowKeySequence('right')).toBe('\x1b[C');
    expect(arrowKeySequence('left')).toBe('\x1b[D');
  });

  it('returns CSI variants when applicationCursorMode is explicitly false', () => {
    expect(arrowKeySequence('up', false)).toBe('\x1b[A');
  });

  it('returns SS3 variants when applicationCursorMode is true', () => {
    expect(arrowKeySequence('up', true)).toBe('\x1bOA');
    expect(arrowKeySequence('down', true)).toBe('\x1bOB');
    expect(arrowKeySequence('right', true)).toBe('\x1bOC');
    expect(arrowKeySequence('left', true)).toBe('\x1bOD');
  });
});
