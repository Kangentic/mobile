#!/usr/bin/env node
/**
 * Picks an available iPhone simulator UDID out of `xcrun simctl list devices
 * available --json`, preferring the newest iOS runtime.
 *
 * Its own file rather than an inline `node -e` for two reasons. It already broke
 * once as a one-liner: a top-level `return` is a syntax error under `node -e`,
 * which wraps the code in a context where returning is illegal, so the picker
 * failed and took the launch step with it. And the shape it parses is Apple's,
 * which changes with Xcode, so it deserves a test rather than hope.
 *
 * Resolving a device at runtime rather than naming one is deliberate: a hardcoded
 * "iPhone 16" turns a routine runner-image bump into a red build for no reason.
 *
 * Usage: node scripts/pickIosSimulator.mjs <simctl devices json path>
 * Prints the UDID on stdout, or exits 1 with an explanation.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {{devices?: Record<string, Array<{udid: string, name: string, isAvailable?: boolean}>>}} catalog
 * @returns {{udid: string, name: string, runtime: string} | null}
 */
export function pickIphoneSimulator(catalog) {
  const devicesByRuntime = catalog?.devices ?? {};

  // Runtime keys look like "com.apple.CoreSimulator.SimRuntime.iOS-26-1". Sorting
  // them as strings puts the highest version last for same-length versions, which
  // is why this compares numerically instead: "iOS-9-0" must not beat "iOS-26-0".
  const iosRuntimes = Object.keys(devicesByRuntime)
    .filter((runtime) => runtime.includes('iOS'))
    .sort((first, second) => runtimeVersion(second) - runtimeVersion(first));

  for (const runtime of iosRuntimes) {
    const candidates = (devicesByRuntime[runtime] ?? []).filter(
      // isAvailable can be absent on older simctl output; treat that as available
      // rather than skipping every device.
      (device) => device.isAvailable !== false && device.name.startsWith('iPhone')
    );
    if (candidates.length > 0) {
      return { udid: candidates[0].udid, name: candidates[0].name, runtime };
    }
  }
  return null;
}

/** Numeric sort key for a runtime identifier, so iOS-26 outranks iOS-9. */
function runtimeVersion(runtime) {
  const match = /iOS-(\d+)(?:-(\d+))?/.exec(runtime);
  if (!match) return -1;
  return Number(match[1]) * 1000 + Number(match[2] ?? 0);
}

function main() {
  const catalogPath = process.argv[2];
  if (!catalogPath) {
    throw new Error('usage: pickIosSimulator.mjs <simctl devices json path>');
  }
  const chosen = pickIphoneSimulator(JSON.parse(readFileSync(catalogPath, 'utf8')));
  if (!chosen) {
    throw new Error('No available iPhone simulator in the simctl device list.');
  }
  process.stdout.write(chosen.udid);
}

// Guarded so a test can import pickIphoneSimulator without running main.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
