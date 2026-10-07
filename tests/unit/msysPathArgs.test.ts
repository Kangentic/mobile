import { describe, expect, it } from 'vitest';

import { looksMsysConverted, undoMsysPathConversion } from '../../scripts/msysPathArgs.mjs';

/**
 * Git Bash rewrites a leading-slash argument before a native program sees it.
 * The environment values here are the ones measured in Git Bash on the dev
 * machine (2026-10-07): MSYSTEM=MINGW64, EXEPATH=`C:\Program Files\Git\bin`,
 * and `/pause` arriving as `C:/Program Files/Git/pause`.
 */
const GIT_BASH_ENV = { MSYSTEM: 'MINGW64', EXEPATH: 'C:\\Program Files\\Git\\bin' };

describe('undoMsysPathConversion', () => {
  it('restores a mock chat command Git Bash turned into a Windows path', () => {
    expect(undoMsysPathConversion('C:/Program Files/Git/pause', GIT_BASH_ENV)).toBe('/pause');
  });

  it('restores a deeper path and a bare root', () => {
    expect(undoMsysPathConversion('C:/Program Files/Git/usr/bin/env', GIT_BASH_ENV)).toBe('/usr/bin/env');
    expect(undoMsysPathConversion('C:/Program Files/Git', GIT_BASH_ENV)).toBe('/');
  });

  it('matches the root without regard to case, as Windows paths do', () => {
    expect(undoMsysPathConversion('c:/program files/git/pause', GIT_BASH_ENV)).toBe('/pause');
  });

  it('leaves ordinary text and paths outside the root alone', () => {
    expect(undoMsysPathConversion('hello world', GIT_BASH_ENV)).toBe('hello world');
    expect(undoMsysPathConversion('C:/Users/dev/notes.txt', GIT_BASH_ENV)).toBe('C:/Users/dev/notes.txt');
    // A sibling folder that merely shares the root's prefix.
    expect(undoMsysPathConversion('C:/Program Files/GitHub/pause', GIT_BASH_ENV)).toBe('C:/Program Files/GitHub/pause');
  });

  it('touches nothing outside Git Bash', () => {
    expect(undoMsysPathConversion('C:/Program Files/Git/pause', {})).toBe('C:/Program Files/Git/pause');
    expect(undoMsysPathConversion('C:/Program Files/Git/pause', { MSYSTEM: 'MINGW64' })).toBe('C:/Program Files/Git/pause');
  });

  it('reads the root from a usr\\bin EXEPATH too', () => {
    expect(undoMsysPathConversion('D:/Tools/Git/pause', { MSYSTEM: 'MINGW64', EXEPATH: 'D:\\Tools\\Git\\usr\\bin\\' })).toBe('/pause');
  });
});

describe('looksMsysConverted', () => {
  it('flags a drive path only under Git Bash', () => {
    expect(looksMsysConverted('C:/anything', { MSYSTEM: 'MINGW64' })).toBe(true);
    expect(looksMsysConverted('C:/anything', {})).toBe(false);
    expect(looksMsysConverted('/pause', { MSYSTEM: 'MINGW64' })).toBe(false);
  });
});
