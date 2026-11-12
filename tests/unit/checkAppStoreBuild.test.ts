/**
 * scripts/checkAppStoreBuild.mjs still runs after its argument parser moved to
 * scripts/lib/cliArguments.mjs.
 *
 * The script runs inside the required "Release counters (stores)" check, whose
 * App Store step only executes on a pull request that changes a counter, so a
 * broken import would not surface on the pull request that broke it. This runs
 * it far enough to prove it loads, before any key read or network call.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repositoryRoot, 'scripts', 'checkAppStoreBuild.mjs');
const run = (scriptArguments: string[]) =>
  spawnSync(process.execPath, [script, ...scriptArguments], { cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000 });

describe('scripts/checkAppStoreBuild.mjs command line', () => {
  it('loads, and reports a missing argument before any network call', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required argument --key.');
  });

  it('reports a malformed command line before any network call', () => {
    const result = run(['--key']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Malformed argument near "--key".');
  });
});
