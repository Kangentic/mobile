module.exports = {
  preset: 'jest-expo',
  testMatch: ['<rootDir>/tests/components/**/*.test.tsx'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
