import { describe, expect, it } from 'vitest';
import {
  approvePermissionKeystrokes,
  askUserQuestionOptionKeystrokes,
  denyPermissionKeystrokes,
} from '@/conversation/promptKeystrokes';

describe('approvePermissionKeystrokes', () => {
  it('selects option 1 and confirms, matching the desktop repo tests', () => {
    expect(approvePermissionKeystrokes()).toBe('1\r');
  });
});

describe('denyPermissionKeystrokes', () => {
  it('sends Esc, the universal reject in Claude Code select prompts', () => {
    expect(denyPermissionKeystrokes()).toBe('\x1b');
  });
});

describe('askUserQuestionOptionKeystrokes', () => {
  it('maps zero-based option indexes to the 1-9 digit select', () => {
    expect(askUserQuestionOptionKeystrokes(0)).toBe('1');
    expect(askUserQuestionOptionKeystrokes(4)).toBe('5');
    expect(askUserQuestionOptionKeystrokes(8)).toBe('9');
  });

  it('throws a RangeError outside 0..8', () => {
    expect(() => askUserQuestionOptionKeystrokes(-1)).toThrow(RangeError);
    expect(() => askUserQuestionOptionKeystrokes(9)).toThrow(RangeError);
  });

  it('throws a RangeError for a non-integer index', () => {
    expect(() => askUserQuestionOptionKeystrokes(1.5)).toThrow(RangeError);
  });
});
