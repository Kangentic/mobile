/**
 * renderableSpawnLabel: the shared sanitizer for the desktop's untrusted
 * in-flight spawn-progress label (kangentic board #639). Three surfaces
 * render its result (the session screen's switching overlay, the Home feed
 * row, and the board card), and each is covered only indirectly through its
 * own component - this file pins the sanitizer's contract directly so a
 * regression in one branch cannot hide behind a call site that happens not
 * to exercise it.
 */
import { describe, expect, it } from 'vitest';
import { renderableSpawnLabel } from '@/lib/spawnLabel';

describe('renderableSpawnLabel', () => {
  it('returns null for null and undefined', () => {
    expect(renderableSpawnLabel(null)).toBeNull();
    expect(renderableSpawnLabel(undefined)).toBeNull();
  });

  it('returns null for an empty string and a whitespace-only string', () => {
    expect(renderableSpawnLabel('')).toBeNull();
    expect(renderableSpawnLabel('   ')).toBeNull();
  });

  it('returns a normal label trimmed of surrounding whitespace', () => {
    expect(renderableSpawnLabel('Switching agent...')).toBe('Switching agent...');
    expect(renderableSpawnLabel('  Switching agent...  ')).toBe('Switching agent...');
  });

  it.each([
    ['U+000A (LF)', '\n'],
    ['U+000D (CR)', '\r'],
    ['U+2028 (LINE SEPARATOR)', '\u2028'],
    ['U+2029 (PARAGRAPH SEPARATOR)', '\u2029'],
  ])('returns null for a label carrying an interior %s', (_description, breakingCharacter) => {
    const labelWithInteriorBreak = `Switching model...${breakingCharacter}(waiting 12s)`;
    expect(renderableSpawnLabel(labelWithInteriorBreak)).toBeNull();
  });

  it('accepts a label exactly at the one-line cap', () => {
    const labelAtCap = 'x'.repeat(45);
    expect(renderableSpawnLabel(labelAtCap)).toBe(labelAtCap);
  });

  it('rejects a label one character over the one-line cap', () => {
    const labelOverCap = 'x'.repeat(46);
    expect(renderableSpawnLabel(labelOverCap)).toBeNull();
  });

  it('applies the cap after trimming, so padding does not push a label over it', () => {
    const paddedLabelAtCap = `  ${'x'.repeat(45)}  `;
    expect(renderableSpawnLabel(paddedLabelAtCap)).toBe('x'.repeat(45));
  });

  it.each([
    'Switching model...',
    'Switching agent...',
    'Applying new settings...',
    'Starting new session...',
  ])('round-trips the real desktop phase label %s unchanged', (phaseLabel) => {
    expect(renderableSpawnLabel(phaseLabel)).toBe(phaseLabel);
  });
});
