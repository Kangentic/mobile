// Component tests run against BOTH platforms, not one.
//
// `preset: 'jest-expo'` on its own sets haste.defaultPlatform to **ios**, so every
// component test resolved iOS modules and nothing ever exercised Android module
// resolution: a `.android.tsx` file, or the Android side of a `Platform.select`,
// was invisible to the suite. That is backwards for this project, where Android is
// the daily target and the only platform that has shipped.
//
// jest-expo ships per-platform presets, so a `projects` array runs each test file
// once per platform. Note the cost: the component tier's test count doubles, which
// is why .github/workflows/ci.yml shards it.
//
// With `projects`, top-level config is ignored, so each project carries the whole
// thing. Hence the shared base below rather than duplicated literals.
const sharedProjectConfig = {
  testMatch: ['**/tests/components/**/*.test.tsx'],
  // The board gives each task its own git worktree under .kangentic/worktrees/,
  // and every one of those contains a full copy of tests/ and node_modules/.
  // Without this, a local run collects every worktree's copy of every test: `jest
  // tests/components` does not scope to a directory, it matches that string as a
  // regex against the whole path. The symptom is a pile of failures from other
  // branches' source, which reads like the change under test broke something.
  // CI never sees it, because a fresh checkout has no worktrees.
  testPathIgnorePatterns: ['/node_modules/', '/\\.kangentic/'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // lucide's "react-native" export condition points at untranspiled ESM,
    // which jest-expo's babel transform does not cover (.mjs); use the CJS build.
    '^lucide-react-native$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
  },
};

module.exports = {
  projects: [
    { ...sharedProjectConfig, displayName: 'ios', preset: 'jest-expo/ios' },
    { ...sharedProjectConfig, displayName: 'android', preset: 'jest-expo/android' },
  ],
};
