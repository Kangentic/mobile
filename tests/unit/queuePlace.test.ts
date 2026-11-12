import { describe, expect, it } from 'vitest';
import type { BoardTaskQueuePlaceWire } from '@kangentic/protocol';
import { queuedCardLabel, queuedCardTip, queuedCount, queuedHeading, queuedReason } from '../../src/lib/queuePlace';

function place(overrides: Partial<BoardTaskQueuePlaceWire>): BoardTaskQueuePlaceWire {
  return { kind: 'column', position: 1, total: 1, column_name: 'Merge', max_agents: 1, ...overrides } as BoardTaskQueuePlaceWire;
}

describe('queuedCardLabel', () => {
  it('reads Next in line at position 1', () => {
    expect(queuedCardLabel(place({ position: 1 }))).toBe('Next in line...');
  });
  it('reads 1 task ahead at position 2', () => {
    expect(queuedCardLabel(place({ position: 2 }))).toBe('1 task ahead...');
  });
  it('reads N tasks ahead above that', () => {
    expect(queuedCardLabel(place({ position: 4 }))).toBe('3 tasks ahead...');
  });
  it('falls back to Queued for no place or an unknown kind', () => {
    expect(queuedCardLabel(null)).toBe('Queued...');
    expect(queuedCardLabel(undefined)).toBe('Queued...');
    expect(queuedCardLabel(place({ kind: 'bogus' as never }))).toBe('Queued...');
  });
});

describe('queuedCardTip', () => {
  it('names the column', () => {
    expect(queuedCardTip(place({ kind: 'column', column_name: 'Merge' }))).toBe('Waiting for a slot in Merge.');
  });
  it('speaks of a free agent slot for global', () => {
    expect(queuedCardTip(place({ kind: 'global', column_name: null }))).toBe('Waiting for a free agent slot.');
  });
  it('is null with no place', () => {
    expect(queuedCardTip(null)).toBeNull();
    expect(queuedCardTip(place({ kind: 'bogus' as never }))).toBeNull();
  });
});

describe('queuedHeading', () => {
  it('uses the card words without dots', () => {
    expect(queuedHeading(place({ position: 1 }))).toBe('Next in line');
    expect(queuedHeading(place({ position: 2 }))).toBe('1 task ahead');
    expect(queuedHeading(place({ position: 5 }))).toBe('4 tasks ahead');
  });
  it('reads Queued with no place', () => {
    expect(queuedHeading(null)).toBe('Queued');
    expect(queuedHeading(place({ kind: 'bogus' as never }))).toBe('Queued');
  });
});

describe('queuedCount', () => {
  it('reads position of total', () => {
    expect(queuedCount(place({ position: 1, total: 2 }))).toBe('1 of 2');
  });
  it('is null with no place', () => {
    expect(queuedCount(null)).toBeNull();
  });
});

describe('queuedReason', () => {
  it('says one agent for a column limit of 1', () => {
    expect(queuedReason(place({ kind: 'column', column_name: 'Merge', max_agents: 1 }))).toEqual({
      kind: 'column',
      text: 'Merge runs one agent at a time',
      columnName: 'Merge',
    });
  });
  it('says N agents for a larger column limit', () => {
    expect(queuedReason(place({ kind: 'column', column_name: 'Merge', max_agents: 3 }))?.text).toBe('Merge runs 3 agents at a time');
  });
  it('words the global limit', () => {
    expect(queuedReason(place({ kind: 'global', column_name: null, max_agents: 1 }))).toEqual({
      kind: 'global',
      text: 'Up to 1 agent runs at a time',
      columnName: null,
    });
    expect(queuedReason(place({ kind: 'global', column_name: null, max_agents: 4 }))?.text).toBe('Up to 4 agents run at a time');
  });
  it('is null without a usable limit or column', () => {
    expect(queuedReason(place({ max_agents: null }))).toBeNull();
    expect(queuedReason(place({ max_agents: 0 }))).toBeNull();
    expect(queuedReason(place({ kind: 'column', column_name: null, max_agents: 2 }))).toBeNull();
    expect(queuedReason(null)).toBeNull();
  });
});
