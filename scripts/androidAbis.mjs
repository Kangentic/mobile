#!/usr/bin/env node
/**
 * Default Android ABI list per eas.json build profile.
 *
 * Native compilation dominates an Android build: the first unrestricted CI run
 * spent 1665 of 1770 seconds inside Gradle, almost all of it compiling C++ for
 * four ABIs. Only `production` actually needs all four, so every other profile
 * builds just the ABI its target device runs. React Native documents
 * `-PreactNativeArchitectures` as the supported way to do this
 * (https://reactnative.dev/docs/build-speed).
 *
 * ABIs are not an eas.json concept, so they live here rather than in that file.
 * tests/unit/buildWorkflow.test.ts asserts every eas.json profile has an entry,
 * so adding a profile without an ABI default fails the suite.
 *
 * Usage:
 *   node scripts/androidAbis.mjs <profile>
 *   node scripts/androidAbis.mjs --profiles
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Keep these in sync with what each profile is actually installed on.
 * - development / preview: the maintainer's physical device, which is arm64.
 * - e2e: the Android emulator, whose standard system images are x86_64. An
 *   arm64-only APK will not install on it, which is the trap worth naming.
 * - production: every ABI, because Play serves real devices including 32-bit
 *   ARM and x86 Chromebooks, and an app bundle must carry them all for Play to
 *   split per device.
 */
export const DEFAULT_ABIS_BY_PROFILE = {
  development: 'arm64-v8a',
  preview: 'arm64-v8a',
  e2e: 'x86_64',
  production: 'armeabi-v7a,arm64-v8a,x86,x86_64',
};

export function readEasProfileNames() {
  const parsed = JSON.parse(readFileSync(join(repositoryRoot, 'eas.json'), 'utf8'));
  return Object.keys(parsed.build ?? {});
}

export function defaultAbisForProfile(profileName) {
  const abis = DEFAULT_ABIS_BY_PROFILE[profileName];
  if (!abis) {
    const known = Object.keys(DEFAULT_ABIS_BY_PROFILE).join(', ');
    throw new Error(`No default ABI list for profile "${profileName}". Known profiles: ${known}`);
  }
  return abis;
}

function main(argv) {
  if (argv.includes('--profiles')) {
    process.stdout.write(`${Object.keys(DEFAULT_ABIS_BY_PROFILE).join('\n')}\n`);
    return;
  }
  const profileName = argv.find((argument) => !argument.startsWith('--'));
  if (!profileName) {
    throw new Error('Pass a profile name, or --profiles to list every profile with a default.');
  }
  process.stdout.write(`${defaultAbisForProfile(profileName)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('androidAbis.mjs')) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
