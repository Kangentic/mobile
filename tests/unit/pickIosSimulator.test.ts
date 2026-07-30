/**
 * Covers scripts/pickIosSimulator.mjs, which chooses the simulator the iOS launch
 * smoke test runs on.
 *
 * It exists because the logic already broke in CI. As an inline `node -e` snippet
 * it used a top-level `return`, which Node rejects as "Illegal return statement",
 * so the picker died and reported the launch step as a failure that looked like the
 * app crashing. It parses Apple's JSON, whose shape moves with Xcode, so it is
 * exactly the sort of thing that should not be trusted un-tested.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { pickIphoneSimulator } from '../../scripts/pickIosSimulator.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const IPHONE_16 = { udid: 'AAAA-1111', name: 'iPhone 16', isAvailable: true };
const IPHONE_15 = { udid: 'BBBB-2222', name: 'iPhone 15', isAvailable: true };
const IPAD = { udid: 'CCCC-3333', name: 'iPad Pro 13-inch (M4)', isAvailable: true };

describe('pickIphoneSimulator', () => {
  it('picks an available iPhone', () => {
    const chosen = pickIphoneSimulator({
      devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [IPAD, IPHONE_16] },
    });
    expect(chosen?.udid).toBe(IPHONE_16.udid);
  });

  it('prefers the newest iOS runtime by version, not by string order', () => {
    // The trap: sorting runtime keys as strings puts "iOS-9-0" after "iOS-26-0",
    // so a naive sort would choose a nine-year-old runtime.
    const chosen = pickIphoneSimulator({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-9-0': [IPHONE_15],
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [IPHONE_16],
      },
    });
    expect(chosen?.runtime).toContain('iOS-26-1');
    expect(chosen?.udid).toBe(IPHONE_16.udid);
  });

  it('skips a runtime whose iPhones are all unavailable', () => {
    const chosen = pickIphoneSimulator({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [{ ...IPHONE_16, isAvailable: false }],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [IPHONE_15],
      },
    });
    expect(chosen?.udid).toBe(IPHONE_15.udid);
  });

  it('treats a missing isAvailable as available', () => {
    // Older simctl output omits the field. Skipping those would find nothing at all.
    const chosen = pickIphoneSimulator({
      devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [{ udid: 'D-4', name: 'iPhone SE' }] },
    });
    expect(chosen?.udid).toBe('D-4');
  });

  it('honours a preferred device name over the default first-iPhone pick', () => {
    // The store screenshots need a 6.9-inch screen (1320x2868) specifically, and
    // the default pick is whatever simctl happens to list first.
    const proMax = { udid: 'PM-1', name: 'iPhone 17 Pro Max', isAvailable: true };
    const chosen = pickIphoneSimulator(
      { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [IPHONE_16, proMax] } },
      ['iPhone 17 Pro Max'],
    );
    expect(chosen?.udid).toBe(proMax.udid);
  });

  it('prefers the named device even when it only exists on an older runtime', () => {
    // The screen size matters more than the iOS version here: settling for the
    // newest runtime's first iPhone would silently change the capture size.
    const proMax = { udid: 'PM-2', name: 'iPhone 16 Pro Max', isAvailable: true };
    const chosen = pickIphoneSimulator(
      {
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [IPHONE_16],
          'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [proMax],
        },
      },
      ['iPhone 16 Pro Max'],
    );
    expect(chosen?.udid).toBe(proMax.udid);
  });

  it('takes preferences in order, so the first listed wins', () => {
    const seventeen = { udid: 'PM-17', name: 'iPhone 17 Pro Max', isAvailable: true };
    const sixteen = { udid: 'PM-16', name: 'iPhone 16 Pro Max', isAvailable: true };
    const chosen = pickIphoneSimulator(
      { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [sixteen, seventeen] } },
      ['iPhone 17 Pro Max', 'iPhone 16 Pro Max'],
    );
    expect(chosen?.udid).toBe(seventeen.udid);
  });

  it('falls back to any iPhone when no preferred device is present', () => {
    // A preference must never turn a working smoke test into a red build just
    // because a runner image dropped one model.
    const chosen = pickIphoneSimulator(
      { devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [IPHONE_16] } },
      ['iPhone 17 Pro Max'],
    );
    expect(chosen?.udid).toBe(IPHONE_16.udid);
  });

  it('ignores non-iOS runtimes', () => {
    // watchOS and tvOS runtimes are in the same list and cannot run this app.
    const chosen = pickIphoneSimulator({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [{ udid: 'W-1', name: 'Apple Watch Series 10' }],
        'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [{ udid: 'T-1', name: 'Apple TV' }],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [IPHONE_15],
      },
    });
    expect(chosen?.udid).toBe(IPHONE_15.udid);
  });

  it('returns null rather than an iPad when no iPhone exists', () => {
    // The launch smoke asserts an iPhone-shaped app starts; silently substituting
    // an iPad would change what is being tested.
    expect(
      pickIphoneSimulator({ devices: { 'com.apple.CoreSimulator.SimRuntime.iOS-26-1': [IPAD] } })
    ).toBeNull();
  });

  it('returns null on an empty or malformed catalog', () => {
    expect(pickIphoneSimulator({ devices: {} })).toBeNull();
    expect(pickIphoneSimulator({})).toBeNull();
  });
});

/**
 * The same failure shape as the picker bug in this file's header, one step later:
 * a script defect that reports the launch step as a crash the app never had.
 *
 * The liveness check used to pipe `launchctl list` straight into `grep -q`.
 * `grep -q` exits at its FIRST match and closes the pipe, so `launchctl list`
 * dies of SIGPIPE with status 141, and because the script runs under
 * `set -o pipefail` that 141 becomes the pipeline's status. The check therefore
 * reported "no longer running" precisely BECAUSE it found the app. It is a race
 * on how much output is still unwritten when grep exits, so it passed seven
 * consecutive runs before failing on run 30461104088, with an empty crash-report
 * group and a screenshot of a fully rendered app as the giveaway.
 */
describe('smoke-ios-simulator.sh liveness check', () => {
  const scriptSource = readFileSync(
    `${repositoryRoot}.github/scripts/smoke-ios-simulator.sh`,
    'utf8'
  );

  it('never pipes a simctl listing into a short-circuiting grep', () => {
    expect(scriptSource).not.toMatch(/simctl spawn[^\n]*\|\s*grep/);
  });

  it('captures the process listing before matching it', () => {
    expect(scriptSource).toMatch(/process_list="\$\(xcrun simctl spawn[^\n]*launchctl list\)"/);
  });

  // The guard above only matters while pipefail is on. If pipefail were ever
  // dropped, a genuinely failing simctl would start passing silently, so the two
  // belong in one assertion rather than drifting apart.
  it('keeps pipefail on, which is what made the broken pipe fatal', () => {
    expect(scriptSource).toContain('set -euo pipefail');
  });
});
