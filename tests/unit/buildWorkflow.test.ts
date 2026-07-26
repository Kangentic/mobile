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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const workflowPath = `${repositoryRoot}.github/workflows/build-android.yml`;
const easProfileScript = `${repositoryRoot}scripts/easProfile.mjs`;

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

function runEasProfileScript(scriptArguments: string[]): string {
  return execFileSync(process.execPath, [easProfileScript, ...scriptArguments], {
    encoding: 'utf8',
    cwd: repositoryRoot,
  }).trim();
}

describe('build-android workflow and eas.json parity', () => {
  it('offers exactly the build profiles eas.json declares', () => {
    expect(readWorkflowProfileChoices().sort()).toEqual(Object.keys(easConfig.build).sort());
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
});

describe('build-android release safety gates', () => {
  it('never submits to Play unless a track was explicitly chosen', () => {
    expect(workflowSource).toContain("inputs.submit_track != 'none'");
  });

  it('puts the submit job behind a protected environment', () => {
    expect(workflowSource).toContain('environment: google-play');
  });

  it('refuses to submit an artifact that is not signed with the upload key', () => {
    expect(workflowSource).toContain('Refuse an unsigned artifact');
    expect(workflowSource).toContain('Verify the artifact is signed with the upload key');
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
});
