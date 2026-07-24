module.exports = {
  preset: 'jest-expo',
  testMatch: ['**/tests/components/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // lucide's "react-native" export condition points at untranspiled ESM,
    // which jest-expo's babel transform does not cover (.mjs); use the CJS build.
    '^lucide-react-native$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js',
  },
};
