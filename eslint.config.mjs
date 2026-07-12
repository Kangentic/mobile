import expoConfig from 'eslint-config-expo/flat.js';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    ignores: ['dist/**', 'node_modules/**', '.expo/**', 'ios/**', 'android/**'],
  },
  ...expoConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]);
