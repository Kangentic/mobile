#!/usr/bin/env node
/**
 * Resolve an eas.json build profile, following its `extends` chain.
 *
 * The GitHub Actions build workflow builds with Gradle rather than
 * `eas build`, so nothing would otherwise read eas.json on a runner and the
 * profile settings would have to be duplicated into workflow YAML. This script
 * keeps eas.json the single source of truth for the things a build actually
 * needs (the `env` block and `android.buildType`), which is what
 * .claude/rules/docs-stay-in-sync.md anchors EAS profile names to.
 *
 * Usage:
 *   node scripts/easProfile.mjs --list
 *   node scripts/easProfile.mjs <profile> --json
 *   node scripts/easProfile.mjs <profile> --field android.buildType
 *   node scripts/easProfile.mjs <profile> --github-env
 *
 * `--github-env` writes the profile's `env` entries to the file named by
 * GITHUB_ENV so later workflow steps inherit them. EXPO_PUBLIC_* values are
 * inlined into the JS bundle by Metro, so they must be present for the Gradle
 * step, not merely for prebuild.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const easConfigPath = join(repositoryRoot, 'eas.json');

/** Keys whose object values merge one level deep rather than being replaced wholesale. */
const DEEP_MERGED_KEYS = ['env', 'android', 'ios'];

export function readBuildProfiles(configPath = easConfigPath) {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  return parsed.build ?? {};
}

/**
 * Merge a parent profile with the child that extends it. EAS replaces scalar
 * and array values outright, and merges `env`/`android`/`ios` one level deep.
 */
function mergeProfiles(parentProfile, childProfile) {
  const merged = { ...parentProfile, ...childProfile };
  for (const key of DEEP_MERGED_KEYS) {
    const parentValue = parentProfile[key];
    const childValue = childProfile[key];
    if (parentValue && childValue) {
      merged[key] = { ...parentValue, ...childValue };
    }
  }
  // `extends` is a resolution directive, not part of the resolved profile.
  delete merged.extends;
  return merged;
}

export function resolveProfile(profileName, buildProfiles) {
  const visitedProfileNames = [];
  const chain = [];

  let currentName = profileName;
  while (currentName) {
    if (visitedProfileNames.includes(currentName)) {
      throw new Error(
        `Circular "extends" in eas.json build profiles: ${[...visitedProfileNames, currentName].join(' -> ')}`
      );
    }
    const currentProfile = buildProfiles[currentName];
    if (!currentProfile) {
      const known = Object.keys(buildProfiles).join(', ');
      throw new Error(`Unknown eas.json build profile "${currentName}". Known profiles: ${known}`);
    }
    visitedProfileNames.push(currentName);
    chain.unshift(currentProfile);
    currentName = currentProfile.extends;
  }

  return chain.reduce((accumulated, profile) => mergeProfiles(accumulated, profile), {});
}

/** Read a dotted path such as `android.buildType` out of a resolved profile. */
export function readField(resolvedProfile, fieldPath) {
  return fieldPath.split('.').reduce((value, segment) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    return value[segment];
  }, resolvedProfile);
}

function main(argv) {
  const buildProfiles = readBuildProfiles();

  if (argv.includes('--list')) {
    process.stdout.write(`${Object.keys(buildProfiles).join('\n')}\n`);
    return;
  }

  const profileName = argv.find((argument) => !argument.startsWith('--'));
  if (!profileName) {
    throw new Error('Pass a profile name, or --list to print every profile name.');
  }

  const resolvedProfile = resolveProfile(profileName, buildProfiles);

  const fieldFlagIndex = argv.indexOf('--field');
  if (fieldFlagIndex !== -1) {
    const fieldPath = argv[fieldFlagIndex + 1];
    if (!fieldPath) {
      throw new Error('--field needs a dotted path, for example android.buildType');
    }
    const value = readField(resolvedProfile, fieldPath);
    process.stdout.write(`${value ?? ''}\n`);
    return;
  }

  if (argv.includes('--github-env')) {
    const githubEnvPath = process.env.GITHUB_ENV;
    if (!githubEnvPath) {
      throw new Error('--github-env only works inside GitHub Actions (GITHUB_ENV is unset).');
    }
    const environmentEntries = Object.entries(resolvedProfile.env ?? {});
    for (const [name, value] of environmentEntries) {
      appendFileSync(githubEnvPath, `${name}=${value}\n`);
      process.stdout.write(`Exported ${name} from the "${profileName}" eas.json profile.\n`);
    }
    if (environmentEntries.length === 0) {
      process.stdout.write(`The "${profileName}" eas.json profile declares no env entries.\n`);
    }
    return;
  }

  process.stdout.write(`${JSON.stringify(resolvedProfile, null, 2)}\n`);
}

// Only run the CLI when invoked directly, so the tests can import the helpers.
if (process.argv[1] && process.argv[1].endsWith('easProfile.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
