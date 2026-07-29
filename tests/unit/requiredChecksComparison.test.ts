/**
 * Pins the required-status-check comparison that `/pull-request` and
 * `/merge-pull-request` use to decide a PR is green.
 *
 * WHY THIS FILE EXISTS. Branch protection is the only authority on which checks
 * are required, and a check that has not registered yet is simply ABSENT from
 * the PR rollup. Absent reads exactly like green when you scan states, and
 * `E2E Tests (Maestro)` registers roughly ten minutes late by design, so both
 * skills compare the required SET against what actually reported.
 *
 * That comparison was first implemented as `comm -23` over two sorted text
 * lists, and it was broken from the first run, silently:
 *
 *   gh api ... --jq '.contexts[]'                    lines end \n
 *   gh pr checks ... --json name,state | jq -r ...   lines end \r\n   (Windows)
 *
 * Every name on one side carried a trailing carriage return, nothing compared
 * equal, and `comm -23` reported SEVEN OF EIGHT required checks missing on a PR
 * where all eight were green. A monitor built on it waited forever on a
 * finished PR.
 *
 * That is the harmless direction. Reverse which side carries the `\r` and
 * `comm -23` prints NOTHING, which reads as "no contexts missing": a false
 * all-green on a PR whose required checks never ran, which `/merge-pull-request`
 * would then merge with `--admin`. The check written to prevent that failure
 * would have caused it, while reporting the words "set-compared".
 *
 * So this file does two things:
 *
 *   1. Executes the jq expression EXTRACTED FROM THE SKILL FILE, not a copy, so
 *      the thing under test is the command the skill actually tells an agent to
 *      run. Same approach and same reasoning as e2eGate.test.ts.
 *   2. Demonstrates the CRLF failure empirically against the text-pipeline form,
 *      so "do not use comm here" is a recorded measurement rather than folklore.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replaceAll('\\', '/');
const pullRequestSkillPath = `${repositoryRoot}.claude/skills/pull-request/SKILL.md`;
const mergePullRequestSkillPath = `${repositoryRoot}.claude/skills/merge-pull-request/SKILL.md`;

function resolveBashExecutable(): string | null {
  if (process.platform !== 'win32') {
    return 'bash';
  }
  const candidates = [
    process.env.KANGENTIC_BASH,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const bashExecutable = resolveBashExecutable();

function hasJq(): boolean {
  if (!bashExecutable) return false;
  return spawnSync(bashExecutable, ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;
}

const canRun = Boolean(bashExecutable) && hasJq();

/**
 * The jq expression the skill prescribes, lifted out of its fenced block.
 * Anchored on `--argjson req` so a reworded surrounding paragraph cannot drift
 * this away, and throwing rather than returning a fallback so a failed
 * extraction is loud instead of silently testing a hand-copied string.
 */
function readComparisonExpression(skillPath: string): string {
  const source = readFileSync(skillPath, 'utf8');
  const match = source.match(/--argjson req "\$req" --argjson rep "\$rep" \\\n\s*'([^']+)'/);
  if (!match) {
    throw new Error(
      `Could not find the jq required-check comparison in ${skillPath}. ` +
        'If the snippet was reformatted, update this regex. Do NOT paste a copy of the expression into this test.',
    );
  }
  return match[1];
}

interface ComparisonResult {
  required: number;
  green: number;
  missing: string[];
}

/** Runs the extracted jq expression against fixture inputs, exactly as the skill invokes it. */
function runComparison(requiredContexts: string[], reported: { name: string; state: string }[]): ComparisonResult {
  if (!bashExecutable) throw new Error('no bash; suite should have been skipped');
  const expression = readComparisonExpression(pullRequestSkillPath);
  const result = spawnSync(
    bashExecutable,
    ['-c', `jq -n --argjson req "$REQ" --argjson rep "$REP" '${expression}'`],
    {
      encoding: 'utf8',
      env: { ...process.env, REQ: JSON.stringify(requiredContexts), REP: JSON.stringify(reported) },
    },
  );
  if (result.status !== 0) {
    throw new Error(`jq failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as ComparisonResult;
}

const ALL_REQUIRED = [
  'Lint (ESLint)',
  'Type check (tsc)',
  'Unit Tests (Vitest)',
  'Component Tests (Jest)',
  'Native config (prebuild)',
  'Release counters (stores)',
  'E2E Tests (Maestro)',
  'cla',
];

const allGreen = ALL_REQUIRED.map((name) => ({ name, state: 'SUCCESS' }));

describe.skipIf(!canRun)('the required-status-check set comparison', () => {
  it('extracts the expression from the skill, not a copy', () => {
    // Non-vacuity guard for everything below.
    const expression = readComparisonExpression(pullRequestSkillPath);
    expect(expression).toContain('missing');
    expect(expression).toContain('SUCCESS');
  });

  it('reports missing: [] when every required check is green', () => {
    const result = runComparison(ALL_REQUIRED, allGreen);
    expect(result.required).toBe(8);
    expect(result.green).toBe(8);
    expect(result.missing).toEqual([]);
  });

  it('flags a required check that has NOT REGISTERED yet', () => {
    // The real failure mode: E2E Tests (Maestro) appears ~10 minutes late, so
    // it is simply absent from the rollup rather than pending.
    const reported = allGreen.filter((check) => check.name !== 'E2E Tests (Maestro)');
    const result = runComparison(ALL_REQUIRED, reported);
    expect(result.missing).toEqual(['E2E Tests (Maestro)']);
  });

  it('flags a required check that registered but is still pending', () => {
    const reported = allGreen.map((check) =>
      check.name === 'Build-dependent' ? check : check.name === 'E2E Tests (Maestro)' ? { ...check, state: 'PENDING' } : check,
    );
    const result = runComparison(ALL_REQUIRED, reported);
    expect(result.missing).toEqual(['E2E Tests (Maestro)']);
  });

  it('flags a required check that FAILED', () => {
    const reported = allGreen.map((check) =>
      check.name === 'Lint (ESLint)' ? { ...check, state: 'FAILURE' } : check,
    );
    const result = runComparison(ALL_REQUIRED, reported);
    expect(result.missing).toEqual(['Lint (ESLint)']);
  });

  it('flags everything when nothing has reported (the conflicting-PR / stacked-PR shape)', () => {
    const result = runComparison(ALL_REQUIRED, [{ name: 'cla', state: 'SUCCESS' }]);
    expect(result.missing).toHaveLength(7);
    expect(result.missing).not.toContain('cla');
  });

  it('is unaffected by a newly promoted context appearing in protection', () => {
    // Protection changed under a PR in flight on 2026-07-28; the comparison
    // must follow the API rather than any list written down anywhere.
    const withNewContext = [...ALL_REQUIRED, 'Brand new (gate)'];
    const result = runComparison(withNewContext, allGreen);
    expect(result.missing).toEqual(['Brand new (gate)']);
  });
});

/**
 * The empirical half: prove the text-pipeline form is broken, so the "use jq"
 * instruction is backed by a measurement rather than an assertion.
 */
describe.skipIf(!canRun)('why the comparison must not be done over text lines', () => {
  /**
   * Reproduces the real pipelines: `gh api --jq` ends lines `\n`, and
   * `gh pr checks --json | jq -r` ends them `\r\n` on Windows. The CR goes on
   * EVERY line, which is the detail that makes or breaks this reproduction:
   * `printf "%s\r\n" "$multi_line_var"` appends a single CR to the whole
   * string, reproduces nothing, and made an earlier version of this test pass
   * against a bug it was not exercising.
   */
  function runCommComparison(required: string[], reported: string[]): string[] {
    if (!bashExecutable) throw new Error('no bash; suite should have been skipped');
    const script = [
      'green=$(printf "%s\\n" "$GREEN" | sed "s/$/\\r/")',
      'comm -23 <(printf "%s\\n" "$REQ" | sort) <(printf "%s\\n" "$green" | sort -u)',
    ].join('\n');
    const result = spawnSync(bashExecutable, ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, REQ: required.join('\n'), GREEN: reported.join('\n') },
    });
    return result.stdout.split('\n').map((line) => line.replace(/\r$/, '')).filter(Boolean);
  }

  it('comm reports required checks missing on a PR where every one is green', () => {
    // The observed production bug, reproduced exactly: identical content on
    // both sides, and comm still finds 7 of 8 "missing", purely from the line
    // endings. This is what left a monitor waiting forever on a finished PR.
    const missing = runCommComparison(ALL_REQUIRED, ALL_REQUIRED);

    expect(missing.length).toBeGreaterThan(0);

    // The jq form, on exactly the same data, gets it right.
    expect(runComparison(ALL_REQUIRED, allGreen).missing).toEqual([]);
  });

  it('comm also mis-reports when a check IS genuinely absent', () => {
    // Not just noise on a green PR: with a real absence present, the answer is
    // still wrong, naming checks that reported fine alongside the one that did
    // not. An operator reading it cannot tell which part to believe.
    const reported = ALL_REQUIRED.filter((name) => name !== 'E2E Tests (Maestro)');
    const commAnswer = runCommComparison(ALL_REQUIRED, reported);

    expect(commAnswer.length).toBeGreaterThan(1);
    expect(runComparison(
      ALL_REQUIRED,
      reported.map((name) => ({ name, state: 'SUCCESS' })),
    ).missing).toEqual(['E2E Tests (Maestro)']);
  });

  it('the jq form still catches a genuinely absent check, which is the whole point', () => {
    // Guards against "fixing" the above by making the comparison permissive.
    // Failing open here would be the dangerous direction: a false all-green
    // that /merge-pull-request would merge with --admin.
    const reported = allGreen.filter((check) => check.name !== 'E2E Tests (Maestro)');
    expect(runComparison(ALL_REQUIRED, reported).missing).toEqual(['E2E Tests (Maestro)']);
  });

  it('both skills prescribe jq and neither reaches for comm or diff', () => {
    for (const skillPath of [pullRequestSkillPath, mergePullRequestSkillPath]) {
      const source = readFileSync(skillPath, 'utf8');
      expect(source).toContain('--argjson req');
      // Mentioning `comm` in the do-not-do-this warning is expected; using it in
      // a fenced command block is not.
      const fencedBlocks = source.match(/```[\s\S]*?```/g) ?? [];
      for (const block of fencedBlocks) {
        expect(block).not.toMatch(/\bcomm\s+-/);
      }
    }
  });
});
