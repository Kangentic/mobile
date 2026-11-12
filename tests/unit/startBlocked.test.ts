import { describe, expect, it } from 'vitest';
import { startBlockedCopy } from '../../src/lib/startBlocked';

describe('startBlockedCopy', () => {
  it.each([
    ['worktree-missing', 'Worktree missing', 'Its worktree folder is gone. Resume makes it again from the branch.'],
    ['folder-missing', 'Folder missing', 'The folder this agent starts in is gone.'],
    ['never-started', "Didn't start", 'The agent never reported that it started.'],
    ['spawn-failed', "Didn't start", 'The terminal could not start. Its window shows why.'],
    ['prompt-too-long', "Didn't start", 'Its prompt is too long for this agent to start with.'],
  ])('gives the desktop words for %s', (reason, label, tip) => {
    expect(startBlockedCopy(reason)).toEqual({ label, tip });
  });

  it.each([['something-new'], ['constructor'], ['toString'], ['__proto__'], ['']])('reads %j as unknown', (reason) => {
    expect(startBlockedCopy(reason)).toBeNull();
  });

  it('reads null and undefined as none', () => {
    expect(startBlockedCopy(null)).toBeNull();
    expect(startBlockedCopy(undefined)).toBeNull();
  });
});
