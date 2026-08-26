import expoConfig from 'eslint-config-expo/flat.js';
import { defineConfig } from 'eslint/config';

export default defineConfig([
  {
    // .kangentic/ holds the desktop app's live session state for this project
    // (gitignored, and its in-use files EPERM on scandir under Windows).
    // scripts/xterm-page/ holds the WebView page's glue fragments: plain
    // browser scripts that scripts/buildXtermHtml.mjs concatenates into ONE
    // IIFE, so their top-level vars are shared page state that a per-file
    // linter can only read as no-undef/no-var noise. They were unlintable
    // before too (the glue lived inside a template literal); the build's
    // per-module syntax compile and tests/unit/xtermPageScripts.test.ts are
    // what cover them.
    ignores: [
      'dist/**',
      'node_modules/**',
      '.expo/**',
      'ios/**',
      'android/**',
      '.kangentic/**',
      '.devrig.local.json',
      'scripts/xterm-page/**',
    ],
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
    // src/demo runs a real pairing handshake of its own, so it sits on the
    // same error paths for the same reason. Its own key material is public,
    // but the ban is on the DIRECTORY's error surface, not on a judgement
    // about which bytes happen to be sensitive today. src/devsupport is in
    // the zone because the demo pulls its loopback transport and stub peer
    // into release builds, where they run the same handshake frames; and
    // app/+native-intent.ts because it feeds raw, attacker-typeable deep-link
    // URLs into the demo predicate before any error boundary exists.
    files: ['src/pairing/**', 'src/channel/**', 'src/demo/**', 'src/devsupport/**', 'src/notifications/**', 'app/+native-intent.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@sentry/*', '**/observability/*', '@/observability/*'],
              message:
                'src/pairing, src/channel, src/demo, src/devsupport, src/notifications and app/+native-intent.ts must not report to Sentry: their error messages can carry ciphertext, key material, or attacker-controlled bytes. See .claude/rules/crash-reporting-scope.md.',
            },
          ],
        },
      ],
    },
  },
]);
