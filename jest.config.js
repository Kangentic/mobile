module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/tests/components/**/*.test.tsx'],
  // A jest run must not crawl the agent worktrees nested under
  // .kangentic/worktrees/ - each carries a full copy of this package, so an
  // unguarded run from the main checkout hits duplicate haste modules and
  // multiplied test files. Anchored to <rootDir> because a worktree's own
  // absolute path contains .kangentic/, and an unanchored pattern would
  // ignore the entire worktree when jest runs inside one.
  modulePathIgnorePatterns: ['<rootDir>[/\\\\]\\.kangentic[/\\\\]'],
  testPathIgnorePatterns: ['[/\\\\]node_modules[/\\\\]', '<rootDir>[/\\\\]\\.kangentic[/\\\\]'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // lucide's "react-native" export condition points at untranspiled ESM,
    // which jest-expo's babel transform does not cover (.mjs); use the CJS build.
    '^lucide-react-native$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
  },
};
