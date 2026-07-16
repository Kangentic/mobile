import expoConfig from 'eslint-config-expo/flat.js';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    // .kangentic/ holds the desktop app's live session state for this project
    // (gitignored, and its in-use files EPERM on scandir under Windows).
    ignores: ['dist/**', 'node_modules/**', '.expo/**', 'ios/**', 'android/**', '.kangentic/**', '.devrig.local.json'],
  },
  ...expoConfig,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
]);
