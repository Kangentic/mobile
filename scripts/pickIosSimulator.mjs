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
 * Usage: node scripts/pickIosSimulator.mjs <simctl devices json path> [--prefer <name>...]
 * Prints the UDID on stdout, or exits 1 with an explanation.
 *
 * `--prefer` exists for the store screenshots, which are the one caller that
 * cannot take whatever iPhone is going: App Store Connect's 6.9-inch shelf
 * wants exactly 1320x2868, which only the Pro Max models produce. It stays a
 * PREFERENCE rather than a requirement so the launch smoke test keeps working
 * on any runner image. A caller that needs the exact size must assert on the
 * captured PNG, not trust the device name.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * @param {{devices?: Record<string, Array<{udid: string, name: string, isAvailable?: boolean}>>}} catalog
 * @returns {{udid: string, name: string, runtime: string} | null}
 */
export function pickIphoneSimulator(catalog, preferredNames = []) {
  const devicesByRuntime = catalog?.devices ?? {};

  // Runtime keys look like "com.apple.CoreSimulator.SimRuntime.iOS-26-1". Sorting
  // them as strings puts the highest version last for same-length versions, which
  // is why this compares numerically instead: "iOS-9-0" must not beat "iOS-26-0".
  const iosRuntimes = Object.keys(devicesByRuntime)
    .filter((runtime) => runtime.includes('iOS'))
    .sort((first, second) => runtimeVersion(second) - runtimeVersion(first));

  const availableIphones = (runtime) =>
    (devicesByRuntime[runtime] ?? []).filter(
      // isAvailable can be absent on older simctl output; treat that as available
      // rather than skipping every device.
      (device) => device.isAvailable !== false && device.name.startsWith('iPhone')
    );

  // Preferences are honoured ACROSS runtimes before falling back, and in the
  // order given: a caller asking for a 6.9-inch device wants that screen more
  // than it wants the newest iOS, and settling for the newest runtime's first
  // iPhone would silently produce a differently-sized capture.
  for (const preferred of preferredNames) {
    for (const runtime of iosRuntimes) {
      const match = availableIphones(runtime).find((device) => device.name === preferred);
      if (match) return { udid: match.udid, name: match.name, runtime };
    }
  }

  for (const runtime of iosRuntimes) {
    const candidates = availableIphones(runtime);
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
  const [catalogPath, ...rest] = process.argv.slice(2);
  if (!catalogPath) {
    throw new Error('usage: pickIosSimulator.mjs <simctl devices json path> [--prefer <name>...]');
  }
  const preferredNames = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--prefer') {
      const name = rest[index + 1];
      if (!name) throw new Error('--prefer needs a device name');
      preferredNames.push(name);
      index += 1;
    }
  }
  const chosen = pickIphoneSimulator(JSON.parse(readFileSync(catalogPath, 'utf8')), preferredNames);
  if (!chosen) {
    throw new Error('No available iPhone simulator in the simctl device list.');
  }
  // The NAME goes to stderr so a caller can see which device it actually got
  // without polluting the udid on stdout, which is consumed by `$(...)`.
  process.stderr.write(`picked ${chosen.name} (${chosen.runtime})\n`);
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
