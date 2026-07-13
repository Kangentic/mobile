import { describe, expect, it } from 'vitest';
import { splitPathForDisplay } from '@/diff/pathDisplay';

describe('splitPathForDisplay', () => {
  it('splits a forward-slash path with the trailing separator on the directory', () => {
    expect(splitPathForDisplay('src/screens/Home.tsx')).toEqual({
      directory: 'src/screens/',
      basename: 'Home.tsx',
    });
  });

  it('splits a backslash path', () => {
    expect(splitPathForDisplay('C:\\Users\\dev\\project\\file.ts')).toEqual({
      directory: 'C:\\Users\\dev\\project\\',
      basename: 'file.ts',
    });
  });

  it('uses the LAST separator when both kinds appear', () => {
    expect(splitPathForDisplay('src\\nested/deep.ts')).toEqual({
      directory: 'src\\nested/',
      basename: 'deep.ts',
    });
    expect(splitPathForDisplay('src/nested\\deep.ts')).toEqual({
      directory: 'src/nested\\',
      basename: 'deep.ts',
    });
  });

  it('returns an empty directory for a bare filename', () => {
    expect(splitPathForDisplay('README.md')).toEqual({ directory: '', basename: 'README.md' });
  });

  it('handles an empty string', () => {
    expect(splitPathForDisplay('')).toEqual({ directory: '', basename: '' });
  });
});
