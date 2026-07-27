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
  {
    // Crash reporting is a data-egress path, so it gets exactly one door.
    // src/observability/ owns the Sentry client and the only place its
    // privacy options can be set; anywhere else importing the SDK could
    // re-enable a default (console breadcrumbs, screenshots) that the init
    // deliberately turned off, or capture an event that never passes
    // through the configured scrubber.
    // See .claude/rules/crash-reporting-scope.md.
    // allowTypeImports because a `import type` is erased at compile time and
    // cannot capture anything at runtime - tests/unit/scrubEvent.test.ts needs
    // Sentry's Event/Breadcrumb types to build its fixtures, and redeclaring
    // them locally would let them drift from the SDK silently.
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/observability/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*'],
              allowTypeImports: true,
              message:
                'Import Sentry only in src/observability/. Everywhere else, crash reporting is automatic via the global handler - see .claude/rules/crash-reporting-scope.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // index.js is the bundle entry and is plain JS, so it gets the base rule.
    // `.mjs` and `.cjs` are in the glob because scripts/ is entirely `.mjs`: a
    // `**/*.js` glob does not match it, which would leave ~15 build-time scripts
    // outside the "one door" ban while the rule file claims it is mechanical.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ignores: ['src/observability/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*'],
              message:
                'Import Sentry only in src/observability/. Everywhere else, crash reporting is automatic via the global handler - see .claude/rules/crash-reporting-scope.md.',
            },
          ],
        },
      ],
    },
  },
  {
    // The crypto and push paths must never hand content to a third party.
    // src/notifications/pushDecrypt.ts states why the error MESSAGE itself
    // is unsafe there: it can echo attacker-controlled bytes. These
    // directories catch and discard without logging, and a deliberate
    // Sentry.captureException() would defeat that. The global handler still
    // reports genuine crashes originating here; what is banned is
    // hand-written capture calls.
    // See .claude/rules/e2e-notification-privacy.md.
    files: ['src/pairing/**', 'src/channel/**', 'src/notifications/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*', '**/observability/*', '@/observability/*'],
              message:
                'src/pairing, src/channel and src/notifications must not report to Sentry: their error messages can carry ciphertext, key material, or attacker-controlled bytes. See .claude/rules/crash-reporting-scope.md.',
            },
          ],
        },
      ],
    },
  },
]);
