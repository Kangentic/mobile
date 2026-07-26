/**
 * Guards the Android build workflow against the two ways it can silently rot.
 *
 * The workflow builds with Gradle rather than `eas build`, so eas.json is no
 * longer read by the build tool itself. That is a deliberate trade (see the CI
 * builds section of docs/developer-guide.md), and these tests are what keeps it
 * honest: the workflow's profile list must stay equal to eas.json's, which is
 * the EAS profile anchor named in .claude/rules/docs-stay-in-sync.md.
 *
 * The second group covers the safety gates on the Play submit job. Those are
 * the difference between "a release needs a deliberate decision" and "a release
 * happens because someone clicked Run workflow".
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowPath = `${repositoryRoot}.github/workflows/build-android.yml`;
const easProfileScript = `${repositoryRoot}scripts/easProfile.mjs`;
const androidAbisScript = `${repositoryRoot}scripts/androidAbis.mjs`;

const workflowSource = readFileSync(workflowPath, 'utf8');

interface EasConfig {
  build: Record<string, { extends?: string; channel?: string; distribution?: string }>;
}

const easConfig = JSON.parse(readFileSync(`${repositoryRoot}eas.json`, 'utf8')) as EasConfig;

/**
 * Pull the `profile` dispatch input's choice list out of the workflow. Parsed
 * as text on purpose: a YAML dependency would be a new package in the lockfile
 * for one assertion.
 */
function readWorkflowProfileChoices(): string[] {
  const lines = workflowSource.split('\n');
  const profileKeyIndex = lines.findIndex((line) => line === '      profile:');
  expect(profileKeyIndex).toBeGreaterThan(-1);

  const optionsKeyIndex = lines.findIndex((line, index) => index > profileKeyIndex && line === '        options:');
  expect(optionsKeyIndex).toBeGreaterThan(-1);

  const choices: string[] = [];
  for (let index = optionsKeyIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^ {10}- ([\w-]+)$/);
    if (!match) {
      break;
    }
    choices.push(match[1]);
  }
  return choices;
}

function runScript(scriptPath: string, scriptArguments: string[]): string {
  return execFileSync(process.execPath, [scriptPath, ...scriptArguments], {
    encoding: 'utf8',
    cwd: repositoryRoot,
  }).trim();
}

function runEasProfileScript(scriptArguments: string[]): string {
  return runScript(easProfileScript, scriptArguments);
}

describe('build-android workflow and eas.json parity', () => {
  it('offers exactly the build profiles eas.json declares, plus "all"', () => {
    const choices = readWorkflowProfileChoices();
    // "all" fans every profile out across runners in parallel; it is a
    // selection mode, not an eas.json profile.
    expect(choices).toContain('all');
    expect(choices.filter((choice) => choice !== 'all').sort()).toEqual(Object.keys(easConfig.build).sort());
  });

  it('gives every eas.json profile a default ABI list', () => {
    // A profile with no ABI default would throw at build time, on the runner,
    // after npm ci and prebuild have already run.
    const profilesWithAbiDefaults = runScript(androidAbisScript, ['--profiles']).split('\n');
    expect(profilesWithAbiDefaults.sort()).toEqual(Object.keys(easConfig.build).sort());
  });

  it('gives the e2e profile an emulator-installable ABI', () => {
    // The Maestro paired suite runs on a standard emulator image, which is
    // x86_64. An arm64-only APK builds and uploads fine and then fails at
    // `adb install` with an unhelpful error.
    expect(runScript(androidAbisScript, ['e2e'])).toContain('x86_64');
  });

  it('builds every ABI for production, since Play splits per device', () => {
    const productionAbis = runScript(androidAbisScript, ['production']).split(',');
    expect(productionAbis.sort()).toEqual(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']);
  });

  it('verifies the artifact ABIs rather than trusting the Gradle flag', () => {
    expect(workflowSource).toContain('verify-android-abis.sh');
  });

  it('sources the profile env from eas.json rather than duplicating it in YAML', () => {
    expect(workflowSource).toContain('scripts/easProfile.mjs');
    // If the flag were ever inlined into the workflow, eas.json would stop
    // being authoritative for it and the two could drift apart unnoticed.
    expect(workflowSource).not.toContain('EXPO_PUBLIC_KANGENTIC_E2E');
    expect(easConfig.build.e2e).toBeDefined();
  });

  it('generates the native project instead of expecting a committed one', () => {
    // .claude/rules/expo-cng.md: android/ is a prebuild artifact.
    expect(workflowSource).toContain('expo prebuild --platform android --no-install');
  });

  it('exports the profile env before prebuild, not just before Gradle', () => {
    // app.config.ts reads EXPO_PUBLIC_KANGENTIC_E2E at config-evaluation time
    // to set android usesCleartextTraffic, and that evaluation happens during
    // prebuild. GITHUB_ENV only affects LATER steps, so exporting after
    // prebuild would produce an e2e APK that builds green but ships without the
    // cleartext manifest entry, and the Maestro paired suite would then fail at
    // relay connect (code 1006) with nothing in the build log to explain it.
    const exportIndex = workflowSource.indexOf('Export the profile env from eas.json');
    const prebuildIndex = workflowSource.indexOf('expo prebuild --platform android');
    expect(exportIndex).toBeGreaterThan(-1);
    expect(prebuildIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(prebuildIndex);
  });
});

describe('build-android release safety gates', () => {
  it('never submits to Play unless a track was explicitly chosen', () => {
    expect(workflowSource).toContain("inputs.submit_track != 'none'");
  });

  it('puts the submit job behind a protected environment', () => {
    expect(workflowSource).toContain('environment: google-play');
  });

  it('verifies the signature in both the build and the submit job', () => {
    // The submit job re-verifies what it downloaded rather than trusting a job
    // output from the build. That is both stronger and necessary: matrix job
    // outputs are not per-instance addressable, so a trusted output would be
    // whichever matrix leg happened to finish last.
    const occurrences = workflowSource.split('verify-android-signature.sh').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('checks the version code against Play before uploading', () => {
    expect(workflowSource).toContain('scripts/checkPlayVersionCode.mjs');
  });

  it('caps artifact retention so storage does not accrue', () => {
    expect(workflowSource).toMatch(/retention-days: \d+/);
  });
});

describe('easProfile.mjs profile resolution', () => {
  it('lists every eas.json build profile', () => {
    expect(runEasProfileScript(['--list']).split('\n')).toEqual(Object.keys(easConfig.build));
  });

  it('resolves the extends chain and merges env', () => {
    const resolved = JSON.parse(runEasProfileScript(['e2e', '--json']));
    expect(resolved.env.EXPO_PUBLIC_KANGENTIC_E2E).toBe('1');
    // Inherited from the preview profile it extends.
    expect(resolved.distribution).toBe('internal');
    // Overridden on the child.
    expect(resolved.channel).toBe('e2e');
    // The directive itself is not part of the resolved profile.
    expect(resolved.extends).toBeUndefined();
  });

  it('reads a dotted field, which is how the workflow picks the Gradle task', () => {
    expect(runEasProfileScript(['e2e', '--field', 'android.buildType'])).toBe('apk');
    expect(runEasProfileScript(['development', '--field', 'android.buildType'])).toBe('apk');
  });

  it('fails loudly on an unknown profile', () => {
    expect(() => runEasProfileScript(['does-not-exist', '--json'])).toThrow();
  });

  it('writes the profile env in GITHUB_ENV format', () => {
    // The workflow relies on this exact shape to get EXPO_PUBLIC_* values into
    // the Gradle step, where Metro inlines them into the bundle. A silent
    // change here would produce an e2e APK without its flag set.
    const githubEnvPath = join(mkdtempSync(join(tmpdir(), 'kangentic-github-env-')), 'github-env');
    writeFileSync(githubEnvPath, '');

    execFileSync(process.execPath, [easProfileScript, 'e2e', '--github-env'], {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_ENV: githubEnvPath },
      encoding: 'utf8',
    });
    expect(readFileSync(githubEnvPath, 'utf8')).toBe('EXPO_PUBLIC_KANGENTIC_E2E=1\n');

    // A profile with no env block must contribute nothing rather than a blank line.
    writeFileSync(githubEnvPath, '');
    execFileSync(process.execPath, [easProfileScript, 'preview', '--github-env'], {
      cwd: repositoryRoot,
      env: { ...process.env, GITHUB_ENV: githubEnvPath },
      encoding: 'utf8',
    });
    expect(readFileSync(githubEnvPath, 'utf8')).toBe('');
  });
});
