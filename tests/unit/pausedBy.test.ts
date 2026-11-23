/**
 * Who paused a task (protocol 0.29.0's `paused_by`) in the desktop's words
 * (kangentic 4fe1dfbdb): the card footer, and the one line under Resume.
 */
import { describe, expect, it } from 'vitest';
import { PAUSED_BY_WIRE_VALUES } from '@kangentic/protocol';
import { pausedFooterLabel, resumePauseNote } from '@/lib/pausedBy';

describe('pausedBy', () => {
  describe('pausedFooterLabel', () => {
    it.each([
      ['idle', 'Paused while idle'],
      ['held', 'Paused'],
      ['system', 'Paused'],
    ])('reads %s as "%s"', (pausedBy, expected) => {
      expect(pausedFooterLabel(pausedBy)).toBe(expected);
    });

    it.each([
      ['null (nobody paused it, or a desktop before 0.29.0)', null],
      ['undefined (the key absent)', undefined],
      ['a value this phone does not know', 'scheduled'],
      ['a value that differs only in case', 'IDLE'],
    ])('reads %s as plain "Paused"', (_label, pausedBy) => {
      expect(pausedFooterLabel(pausedBy)).toBe('Paused');
    });
  });

  describe('resumePauseNote', () => {
    it.each([
      ['idle', 'Paused while idle.'],
      ['held', 'Stays paused until resumed.'],
    ])('gives %s the line "%s"', (pausedBy, expected) => {
      expect(resumePauseNote(pausedBy)).toBe(expected);
    });

    it.each([
      ['system (the desktop paused it on its own)', 'system'],
      ['null', null],
      ['undefined', undefined],
      ['a value this phone does not know', 'scheduled'],
    ])('gives %s no line', (_label, pausedBy) => {
      expect(resumePauseNote(pausedBy)).toBeNull();
    });
  });

  // The protocol's list is the contract: a value it adds must be given words
  // here before this test can pass (the record is typed against the union, so
  // the compiler forces the same thing).
  it('covers exactly the values the protocol package knows', () => {
    expect([...PAUSED_BY_WIRE_VALUES].sort()).toEqual(['held', 'idle', 'system']);
  });
});
