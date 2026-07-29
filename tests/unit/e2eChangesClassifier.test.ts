/**
 * Extracts the `Classify the diff` step out of `.github/workflows/e2e.yml` and
 * EXECUTES it against representative file lists, asserting `run-e2e` rather
 * than grepping the regex.
 *
 * `tests/unit/e2eGate.test.ts` covers the GATE - what the required check does
 * with the classifier's answer. This covers the classifier itself, which is a
 * different failure surface: the gate decides whether a skip is honest, the
 * classifier decides whether the emulators run at all.
 *
 * Two properties are worth locking, and they fail in opposite directions:
 *
 *   A false SKIP is the dangerous one. It ships an untested APK behind a green
 *   check. The classifier is deliberately written to fail safe by RUNNING, so
 *   every exclusion added to it is a small, deliberate hole - and each one is a
 *   plain regex alternation, which is easy to widen by accident. `^tests/` must
 *   not swallow `src/tests-helper.ts`; `^store/screenshots/` must not swallow
 *   `scripts/storeScreenshots.mjs` or `.maestro/screenshots/`.
 *
 *   A false RUN costs half an hour of two emulators. That is the cost the
 *   exclusions exist to avoid, and a re-capture rewrites 18 PNGs at once.
 *
 * The exclusion list has also now been merged by hand once: `^tests/` and
 * `^store/screenshots/` were added on two branches independently and combined
 * into one alternation during a merge, with no test standing under it. That is
 * exactly the edit this file is here to catch.
 *
 * Bash is available on the ubuntu runner that hosts the unit tier, and locally
 * through Git Bash on Windows.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const workflowPath = `${repositoryRoot}.github/workflows/e2e.yml`;

interface ClassifierStep {
  name?: string;
  run?: string;
}
interface ClassifierJob {
  steps?: ClassifierStep[];
}
interface E2eWorkflow {
  jobs?: Record<string, ClassifierJob>;
}

const CLASSIFY_STEP_NAME = 'Classify the diff';

/**
 * Read from the workflow rather than copied into `tests/`, so what runs here is
 * what CI runs. A copy would keep passing after the workflow drifted, which is
 * the whole failure mode being guarded.
 */
function readClassifierDecision(): string {
  const workflow = parseYaml(readFileSync(workflowPath, 'utf8')) as E2eWorkflow;
  const changesJob = workflow.jobs?.changes;
  if (!changesJob) {
    throw new Error('e2e.yml has no `changes` job. If it was renamed, update this test.');
  }
  const step = (changesJob.steps ?? []).find((candidate) => candidate.name === CLASSIFY_STEP_NAME);
  if (step?.run === undefined) {
    const found = (changesJob.steps ?? []).map((candidate) => candidate.name ?? '(unnamed)').join(', ');
    throw new Error(
      `The \`changes\` job has no step named "${CLASSIFY_STEP_NAME}". Found: ${found}. ` +
        'Rename this constant to match, do NOT fall back to picking a step by position.',
    );
  }
  return step.run;
}

const classifierScript = readClassifierDecision();

/**
 * Runs ONLY the decision the classifier makes about a file list.
 *
 * The step's own script starts by resolving a base SHA and diffing, which needs
 * a git history and a GitHub event payload. Re-deriving the condition here would
 * mean copying the regex, so the regex is lifted out of the real script instead
 * and fed a list directly - the alternation under test is the one in the file.
 */
function extractExclusionPattern(): string {
  const match = /grep -qvE '([^']+)'/.exec(classifierScript);
  if (match === null) {
    throw new Error(
      'Could not find the `grep -qvE` exclusion pattern in the classifier. If the classifier ' +
        'stopped using grep, rewrite this test against whatever replaced it - do not delete it.',
    );
  }
  return match[1];
}

const exclusionPattern = extractExclusionPattern();

/**
 * Whether ONE path is covered by the exclusion list, evaluated by the same grep
 * the workflow runs.
 *
 * Deliberately one path per invocation. The workflow pipes the whole file list
 * into a single `grep -qvE`, and mirroring that here meant passing a
 * newline-joined string as a process argument - which Node mangles on Windows,
 * silently, so the test reported a false RUN for a diff the real classifier
 * skips. That would have been a test failing for a reason that has nothing to
 * do with the thing under test, on the machine this repo is developed on.
 */
function isExcluded(changedFile: string): boolean {
  const result = spawnSync('bash', ['-c', 'printf "%s\\n" "$1" | grep -qE "$2"', 'bash', changedFile, exclusionPattern], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

/**
 * true when the classifier would run E2E for this diff.
 *
 * `grep -qvE` over a list succeeds when ANY line fails to match, so running the
 * suite is exactly "some changed file is not excluded". Composing per-file
 * results in TypeScript is equivalent and avoids the argument-passing hazard.
 */
function runsE2eFor(changedFiles: string[]): boolean {
  return changedFiles.some((changedFile) => !isExcluded(changedFile));
}

/**
 * vitest's default per-test timeout is 5s, which is not enough headroom here.
 *
 * Every case shells out to real `bash` once per changed path, and a process
 * spawn on Windows costs orders of magnitude more than on the Linux CI runner -
 * so the multi-file cases below sit right at the default on the machine this
 * repo is developed on, and tip over it the moment anything else is using the
 * box. That failure reads as "the classifier is broken" rather than "the test
 * was not given time to spawn five shells", which is the same class of
 * misleading local failure the header above describes.
 */
const BASH_SPAWN_TIMEOUT_MS = 30_000;

describe('the e2e changes classifier', () => {
  it('finds the exclusion pattern at all', () => {
    // Non-vacuity guard: every assertion below is trivially satisfiable against
    // an empty pattern, so a regex that stopped being found would read as a
    // pass. Naming the known exclusions also makes an accidental deletion loud.
    expect(exclusionPattern.length).toBeGreaterThan(0);
    expect(exclusionPattern).toContain('^docs/');
    expect(exclusionPattern).toContain('^tests/');
    expect(exclusionPattern).toContain('^store/screenshots/');
  });

  describe('runs the suite for anything that can change the APK', () => {
    it.each([
      ['app source', 'src/screens/BoardScreen.tsx'],
      ['a route', 'app/(tabs)/_layout.tsx'],
      ['the app config', 'app.config.ts'],
      ['a config plugin', 'plugins/withAndroidPushService.ts'],
      ['a dependency change', 'package.json'],
      // .github/ is deliberately NOT excluded: a workflow change has to be
      // exercised by the thing it changes.
      ['a workflow', '.github/workflows/e2e.yml'],
      // The capture rig is CODE, and sits one path segment away from the PNGs
      // that are excluded. This is the pair most likely to be over-matched.
      ['the capture script', 'scripts/storeScreenshots.mjs'],
      ['the capture flow', '.maestro/screenshots/store-capture.yaml'],
    ])(
      'runs for %s',
      (_label, file) => {
        expect(runsE2eFor([file])).toBe(true);
      },
      BASH_SPAWN_TIMEOUT_MS,
    );
  });

  describe('skips the suite for what cannot', () => {
    it.each([
      ['docs', ['docs/developer-guide.md']],
      ['a root markdown file', ['README.md']],
      ['agent rules', ['.claude/rules/e2e-maestro-runs.md']],
      ['tests', ['tests/unit/storeScreenshots.test.ts']],
      ['one store screenshot', ['store/screenshots/android/phone/01-agents.png']],
      [
        'a whole re-capture',
        [
          'store/screenshots/android/phone/01-agents.png',
          'store/screenshots/android/seven-inch/02-session-terminal.png',
          'store/screenshots/android/ten-inch/05-board.png',
          'store/screenshots/ios/iphone-6.9/06-file-diff.png',
          'store/screenshots/README.md',
        ],
      ],
    ])(
      'skips for %s',
      (_label, files) => {
        expect(runsE2eFor(files as string[])).toBe(false);
      },
      BASH_SPAWN_TIMEOUT_MS,
    );
  });

  describe('does not over-match a prefix exclusion', () => {
    it.each([
      // `^tests/` must anchor. A source file whose name merely starts with the
      // same letters ships in the binary, and so does one in a nested `tests/`
      // directory - dropping the `^` makes the second one skip silently.
      ['src/tests-helper.ts'],
      ['src/tests/renderHelper.ts'],
      ['src/store/screenshotsHelper.ts'],
      // Not the screenshot OUTPUT directory, despite the shared first segment.
      ['store/config.ts'],
    ])(
      'runs for %s',
      (file) => {
        expect(runsE2eFor([file])).toBe(true);
      },
      BASH_SPAWN_TIMEOUT_MS,
    );
  });

  it(
    'runs when a skippable file travels with a source change',
    () => {
      // The dangerous direction: one excluded path must never license skipping a
      // diff that also touches the app.
      expect(runsE2eFor(['store/screenshots/android/phone/01-agents.png', 'src/screens/BoardScreen.tsx'])).toBe(true);
      expect(runsE2eFor(['docs/developer-guide.md', 'src/state/boardStore.ts'])).toBe(true);
    },
    BASH_SPAWN_TIMEOUT_MS,
  );
});
