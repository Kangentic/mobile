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
  // Without this, a local run collects every worktree's copy of every test:
  // `jest tests/components` does not scope to a directory, it matches that
  // string as a regex against the whole path. The symptom is a pile of failures
  // from other branches' source, which reads like the change under test broke
  // something. CI never sees it, because a fresh checkout has no worktrees.
  // modulePathIgnorePatterns covers the haste map too, so the duplicate-module
  // warnings go with it.
  //
  // Anchored to <rootDir>, which is load-bearing: a worktree's OWN absolute path
  // contains .kangentic/, so an unanchored pattern ignores the entire worktree
  // whenever jest runs inside one - collecting nothing and passing vacuously.
  modulePathIgnorePatterns: ['<rootDir>[/\\\\]\\.kangentic[/\\\\]'],
  testPathIgnorePatterns: ['[/\\\\]node_modules[/\\\\]', '<rootDir>[/\\\\]\\.kangentic[/\\\\]'],
  // jest-expo's own transformIgnorePatterns, restated with two additions.
  // Jest does not merge this key with the preset's, so a project that sets it
  // replaces the whole list, hence the two trailing entries copied as they are.
  //
  // `@shopify/flash-list` 2.3.x ships an ES-module `dist/index.js` (no CJS
  // build), and Sentry's 10.7x packages (`@sentry/core`, `@sentry/react`,
  // `@sentry/browser`, `@sentry-internal/*`) resolve to `build/esm` entries
  // through the `react-native` export condition. None is in the preset's
  // allowlist, so the first import of either failed to PARSE ("Cannot use
  // import statement outside a module"): BoardScreen, TriageHomeScreen,
  // SessionScreen, SettingsScreen and every suite that reaches them. The
  // allowlist is a prefix match, so the bare `@sentry` covers both scopes.
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry|@shopify/flash-list|native-base|standard-navigation))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
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
