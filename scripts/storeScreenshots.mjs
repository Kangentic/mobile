#!/usr/bin/env node
/**
 * Captures the Play Store listing screenshots at each shelf's exact required
 * geometry.
 *
 *   node scripts/storeScreenshots.mjs <phone|seven-inch|ten-inch|all> [options]
 *
 *     --serial <adb serial>   pick the device when more than one is attached
 *     --keep-geometry         skip the wm size/density restore (for iterating)
 *     --dry-run               print the plan and exit without touching a device
 *
 * WHY THIS EXISTS RATHER THAN A PLAIN screencap
 *
 * Google Play requires 16:9 or 9:16 on ALL THREE Android shelves, tablets
 * included. A real 7-inch tablet (600x960dp) and 10-inch tablet (800x1280dp)
 * are not 9:16, and the emulator's own default is 1080x2400 (9:20), so nothing
 * on hand produces a compliant frame on its own. Letterboxing the difference
 * would mean compositing, which would mean an image toolchain this repo does
 * not have (no sharp, and SVG text rendering on Windows is unreliable).
 *
 * Setting resolution and density INDEPENDENTLY dodges all of that: each shelf
 * below is exactly 9:16, inside its pixel bounds, AND lands on genuine
 * per-form-factor dp geometry - so the tablet captures are faithful layouts
 * rather than upscaled phone shots. Crossing 600dp is what triggers any
 * large-screen layout behaviour, which is why reviewing these captures IS the
 * tablet-layout verification.
 *
 * Preconditions: the MOCK rig (`npm run dev:mock`) against a DEV build. See the
 * header of .maestro/screenshots/store-capture.yaml - a release APK silently
 * shows an unpaired "Connecting to your desktop..." screen instead, because
 * isMockDesktopEnabled() is `__DEV__ && ...`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE_FLOW = join(repositoryRoot, '.maestro', 'screenshots', 'store-capture.yaml');

/**
 * Every shelf Play demands, with the geometry that satisfies it.
 *
 * `density` is the field to distrust. 480 and 320 are standard buckets; 280 is
 * NOT (the buckets either side are 240 and 320), and Android resolves drawables
 * to the nearest bucket, so a non-standard value can produce a frame that looks
 * plausible while sizing against resources the app was never designed for. The
 * script reads the density back after setting it, but a readback only proves it
 * was applied, not that it rendered well - look at the 7-inch captures.
 *
 * If 280 misbehaves, `1200x2133 @ 320` gives ~600x1066dp: also exactly 9:16,
 * both sides inside 320-3840, on a standard bucket, and closer to a real
 * 7-inch device.
 */
export const SHELVES = {
  phone: {
    width: 1080,
    height: 1920,
    density: 480,
    outputDirectory: 'store/screenshots/android/phone',
    playRequirement: '9:16, each side 320-3840px, 1080px+ for promotion eligibility',
  },
  'seven-inch': {
    width: 1080,
    height: 1920,
    density: 280,
    outputDirectory: 'store/screenshots/android/seven-inch',
    playRequirement: '9:16, each side 320-3840px',
  },
  'ten-inch': {
    width: 1440,
    height: 2560,
    density: 320,
    outputDirectory: 'store/screenshots/android/ten-inch',
    playRequirement: '9:16, each side 1080-7680px',
  },
};

/** Must match the takeScreenshot paths in .maestro/screenshots/store-capture.yaml. */
export const SHOT_NAMES = [
  '01-agents',
  '02-session-terminal',
  '03-session-chat',
  '04-session-changes',
  '05-board',
  '06-file-diff',
];

const APP_PACKAGE = 'com.kangentic.mobile';

/**
 * THROWS rather than calling process.exit.
 *
 * This matters more than it looks. captureShelf leaves the device in demo mode
 * at an overridden resolution and restores both in a `finally`, and
 * `process.exit` skips finally blocks outright - so the first version of this
 * left the emulator pinned at 1080x1920 with a fake 09:30 clock every time a
 * capture failed, which is the state the next run then inherits and reasons
 * about. Failing by throwing keeps the restore honest.
 */
function fail(message) {
  throw new Error(message);
}

function log(message) {
  console.log(`[shots] ${message}`);
}

/**
 * Reads width and height out of a PNG's IHDR chunk.
 *
 * Exported and dependency-free so the dimension gate has a unit test. This is
 * the guard that matters: a capture at the wrong size is rejected by the store
 * at upload time, long after the emulator has been torn down, and this repo has
 * been bitten before by an artifact that looked green and was worthless.
 *
 * Layout: 8-byte signature, then a chunk header (4-byte length, 4-byte type)
 * followed by IHDR's width and height as big-endian uint32s at offsets 16 and
 * 20.
 */
export function readPngSize(buffer) {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < 24) {
    throw new Error('not a PNG: shorter than a signature plus IHDR header');
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (buffer[index] !== PNG_SIGNATURE[index]) {
      throw new Error('not a PNG: bad signature');
    }
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('not a PNG: first chunk is not IHDR');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Checks one capture against a shelf. Returns null when it passes, or a
 * human-readable reason when it does not, so the caller can report every
 * failure at once rather than dying on the first.
 */
export function describeDimensionMismatch(shotName, actualSize, shelf) {
  if (actualSize.width === shelf.width && actualSize.height === shelf.height) return null;
  return `${shotName}.png is ${actualSize.width}x${actualSize.height}, expected ${shelf.width}x${shelf.height}`;
}

const ADB_TIMEOUT_MS = 20_000;

/**
 * A small bounded adb runner rather than a reuse of mobileInspect.mjs's.
 *
 * That one carries a wedged-server recovery path built for `screencap`'s bulk
 * transfers, which is the case that actually stalls adb. Nothing here moves
 * more than a line of text: Maestro takes the screenshots. Bounding the call is
 * still worth it, because a wedged server BLOCKS rather than erroring.
 */
function adb(args, { allowFailure = false } = {}) {
  const serial = process.env.ANDROID_SERIAL;
  const fullArgs = serial ? ['-s', serial, ...args] : args;
  const result = spawnSync('adb', fullArgs, { encoding: 'utf8', timeout: ADB_TIMEOUT_MS });
  if (result.error) {
    if (allowFailure) return '';
    fail(`adb ${args.join(' ')} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return '';
    fail(`adb ${args.join(' ')} exited ${result.status}: ${(result.stderr ?? '').trim()}`);
  }
  return (result.stdout ?? '').trim();
}

/**
 * Refuses to capture while expo-dev-menu's floating "Tools" button is on.
 *
 * That button is a dev-build-only overlay pinned over the app's top-right
 * corner, so it lands in EVERY frame and reads as a doubled, half-broken
 * settings icon. It cost a full batch of otherwise-good captures before anyone
 * looked closely, which is exactly the failure this guard exists to make
 * impossible: the shots are still correctly sized and still verify, so nothing
 * downstream notices.
 *
 * It is a per-install device preference with no adb surface, hence a check with
 * instructions rather than an automatic fix.
 */
function assertNoDevToolsBubble() {
  const serial = process.env.ANDROID_SERIAL;
  const result = spawnSync('maestro', [...(serial ? ['--device', serial] : []), 'hierarchy'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    log('could not read the view hierarchy; skipping the dev-tools-bubble check');
    return;
  }
  if (result.stdout.includes('"accessibilityText" : "Tools"')) {
    fail(
      'expo-dev-menu\'s floating "Tools" button is enabled and will appear in every capture.\n' +
        '  Turn it off once, on the device: open the dev menu (adb shell input keyevent 82),\n' +
        '  scroll to the bottom, and switch "Tools button" off. Then re-run.',
    );
  }
  log('no dev-tools bubble over the app');
}

function applyGeometry(shelf) {
  log(`setting ${shelf.width}x${shelf.height} at density ${shelf.density}`);
  adb(['shell', 'wm', 'size', `${shelf.width}x${shelf.height}`]);
  adb(['shell', 'wm', 'density', String(shelf.density)]);

  // Read both back. `wm size` reports an "Override size" line once overridden;
  // a silent no-op here would otherwise produce correctly-named captures at the
  // wrong geometry, which is the failure this whole script exists to prevent.
  const reportedSize = adb(['shell', 'wm', 'size']);
  const reportedDensity = adb(['shell', 'wm', 'density']);
  if (!reportedSize.includes(`${shelf.width}x${shelf.height}`)) {
    fail(`wm size did not take: device reports "${reportedSize.replace(/\s+/g, ' ')}"`);
  }
  if (!reportedDensity.includes(String(shelf.density))) {
    fail(`wm density did not take: device reports "${reportedDensity.replace(/\s+/g, ' ')}"`);
  }
  log(`geometry confirmed: ${reportedSize.replace(/\s+/g, ' ')} | ${reportedDensity.replace(/\s+/g, ' ')}`);
}

function restoreGeometry() {
  log('restoring the device to its own resolution and density');
  adb(['shell', 'wm', 'size', 'reset'], { allowFailure: true });
  adb(['shell', 'wm', 'density', 'reset'], { allowFailure: true });
}

/**
 * SystemUI demo mode: a fixed clock, a full battery, full signal and no
 * notification icons.
 *
 * Three commands, and without them every frame carries the emulator's real
 * clock and whatever debug notification icons happen to be showing, which reads
 * as an amateur listing rather than a product shot.
 */
function enterDemoMode() {
  adb(['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
  const demo = (extraArgs) =>
    adb(['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', ...extraArgs], { allowFailure: true });
  // EXIT BEFORE ENTERING. `enter` is not idempotent: issued while demo mode is
  // already on, the network commands below ADD a second wifi glyph rather than
  // replacing the first, and the frame ships with two identical icons side by
  // side. Reproduced deliberately, and it is not hypothetical - a capture run
  // in this state produced exactly that.
  //
  // Demo mode outlives this script whenever the exit in `finally` does not run
  // (a kill, a crash, a disconnected device), so "already on" is the normal
  // state after any interrupted run, not an exotic one. Starting from a known
  // clean bar costs one broadcast.
  demo(['-e', 'command', 'exit']);
  demo(['-e', 'command', 'enter']);
  demo(['-e', 'command', 'clock', '-e', 'hhmm', '0930']);
  demo(['-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false']);
  // `fully true` is what removes the "!" overlay: without it the demo wifi icon
  // renders as connected-but-no-internet, which is a detail a reviewer notices
  // and a user reads as a broken app. Mobile is HIDDEN rather than shown - the
  // first revision showed both and produced two signal glyphs side by side.
  demo(['-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true']);
  demo(['-e', 'command', 'network', '-e', 'mobile', 'hide']);
  demo(['-e', 'command', 'notifications', '-e', 'visible', 'false']);
  log('status bar pinned to 09:30, full battery, full wifi, no notification icons');
}

function exitDemoMode() {
  adb(['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', '-e', 'command', 'exit'], {
    allowFailure: true,
  });
}

/**
 * Force-stop and relaunch rather than letting the app ride the configuration
 * change. The session screen hosts an xterm WebView whose PTY grid is
 * negotiated with the desktop, and a resize mid-session can leave it on a stale
 * grid - visible in the capture, and only in the capture.
 */
function relaunchApp() {
  adb(['shell', 'am', 'force-stop', APP_PACKAGE]);
  adb(['shell', 'monkey', '-p', APP_PACKAGE, '-c', 'android.intent.category.LAUNCHER', '1']);
  log('app relaunched into the new geometry');
}

/** Matches the flow's `env.OUTPUT_DIR`, and is a folder name rather than a path. */
const MAESTRO_SHOT_SUBDIRECTORY = 'shots';

/**
 * Runs the flow with its artifact directory PINNED.
 *
 * `--debug-output` is what makes the captures findable. Left to itself Maestro
 * writes to ~/.maestro/tests/<timestamp>/, and a timestamped directory has to
 * be guessed at afterwards - "newest directory wins" races a concurrent run and
 * silently collects the wrong shelf's images.
 */
function runMaestro(maestroRunDirectory) {
  const serial = process.env.ANDROID_SERIAL;
  const args = [
    ...(serial ? ['--device', serial] : []),
    'test',
    '--debug-output',
    maestroRunDirectory,
    '-e',
    `OUTPUT_DIR=${MAESTRO_SHOT_SUBDIRECTORY}`,
    CAPTURE_FLOW,
  ];
  log(`maestro ${args.join(' ')}`);
  const result = spawnSync('maestro', args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) fail(`could not start maestro: ${result.error.message}`);
  if (result.status !== 0) fail(`the capture flow failed (maestro exited ${result.status})`);
}

/** Depth-first search for a file by name, so a Maestro layout change cannot strand the captures. */
function findFileNamed(rootDirectory, fileName) {
  if (!existsSync(rootDirectory)) return null;
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true })) {
    const candidate = join(rootDirectory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileNamed(candidate, fileName);
      if (nested) return nested;
    } else if (entry.name === fileName) {
      return candidate;
    }
  }
  return null;
}

/**
 * Moves the run's captures into the shelf directory.
 *
 * The expected location is
 * <run>/<flow>/takeScreenshot/<OUTPUT_DIR>/<name>.png, but that layout is
 * Maestro's business and has already surprised us once, so fall back to
 * searching the pinned run directory rather than failing on a path.
 */
function collectCaptures(maestroRunDirectory, absoluteOutputDirectory) {
  const missing = [];
  for (const shotName of SHOT_NAMES) {
    const target = join(absoluteOutputDirectory, `${shotName}.png`);
    if (existsSync(target)) continue;
    const produced = findFileNamed(maestroRunDirectory, `${shotName}.png`);
    if (produced) {
      renameSync(produced, target);
      continue;
    }
    missing.push(shotName);
  }
  if (missing.length > 0) {
    fail(`the flow completed but produced no PNG for: ${missing.join(', ')} (searched ${maestroRunDirectory})`);
  }
  log(`collected ${SHOT_NAMES.length} captures into ${absoluteOutputDirectory}`);
}

function verifyCaptures(absoluteOutputDirectory, shelf) {
  const problems = [];
  for (const shotName of SHOT_NAMES) {
    const capturePath = join(absoluteOutputDirectory, `${shotName}.png`);
    let size;
    try {
      size = readPngSize(readFileSync(capturePath));
    } catch (error) {
      problems.push(`${shotName}.png could not be read as a PNG: ${error.message}`);
      continue;
    }
    const mismatch = describeDimensionMismatch(shotName, size, shelf);
    if (mismatch) problems.push(mismatch);
  }
  if (problems.length > 0) {
    fail(`captures do not meet the shelf's requirement (${shelf.playRequirement}):\n  ${problems.join('\n  ')}`);
  }
  log(`all ${SHOT_NAMES.length} captures verified at ${shelf.width}x${shelf.height}`);
}

function captureShelf(shelfName, options) {
  const shelf = SHELVES[shelfName];
  const absoluteOutputDirectory = join(repositoryRoot, shelf.outputDirectory);
  log(`=== ${shelfName}: ${shelf.width}x${shelf.height} @ ${shelf.density}dpi -> ${shelf.outputDirectory}`);

  mkdirSync(absoluteOutputDirectory, { recursive: true });
  // Clear only this shelf's PNGs, so a shot removed from the flow cannot linger
  // and be uploaded as though it were current.
  for (const entry of readdirSync(absoluteOutputDirectory)) {
    if (entry.endsWith('.png')) rmSync(join(absoluteOutputDirectory, entry));
  }

  const maestroRunDirectory = join(tmpdir(), `kangentic-store-shots-${shelfName}`);
  rmSync(maestroRunDirectory, { recursive: true, force: true });

  applyGeometry(shelf);
  relaunchApp();
  assertNoDevToolsBubble();
  enterDemoMode();
  try {
    runMaestro(maestroRunDirectory);
    collectCaptures(maestroRunDirectory, absoluteOutputDirectory);
    verifyCaptures(absoluteOutputDirectory, shelf);
  } finally {
    exitDemoMode();
    if (!options.keepGeometry) restoreGeometry();
  }
}

function main() {
  const args = process.argv.slice(2);
  const serialIndex = args.indexOf('--serial');
  if (serialIndex >= 0) {
    const serial = args[serialIndex + 1];
    if (!serial) fail('--serial needs a value');
    process.env.ANDROID_SERIAL = serial;
    args.splice(serialIndex, 2);
  }
  const options = {
    keepGeometry: args.includes('--keep-geometry'),
    dryRun: args.includes('--dry-run'),
  };
  const positional = args.filter((argument) => !argument.startsWith('--'));
  const requested = positional[0];

  if (!requested || (requested !== 'all' && !(requested in SHELVES))) {
    fail(`usage: storeScreenshots.mjs <${Object.keys(SHELVES).join('|')}|all> [--serial <s>] [--keep-geometry]`);
  }
  const shelfNames = requested === 'all' ? Object.keys(SHELVES) : [requested];

  if (options.dryRun) {
    for (const shelfName of shelfNames) {
      const shelf = SHELVES[shelfName];
      log(`${shelfName}: ${shelf.width}x${shelf.height} @ ${shelf.density}dpi -> ${shelf.outputDirectory}`);
      log(`  Play requires ${shelf.playRequirement}`);
    }
    return;
  }

  if (!existsSync(CAPTURE_FLOW)) fail(`no capture flow at ${CAPTURE_FLOW}`);

  for (const shelfName of shelfNames) {
    captureShelf(shelfName, options);
  }
  log('done. Review every frame before uploading: these are product claims, not test output.');
}

// Guarded so the tests can import the pure helpers without driving a device.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`[shots] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
