import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static checks over the Maestro flows.
 *
 * These exist because a bad flow does not fail cheaply. An unknown command is
 * a PARSE error that aborts the whole suite before a single flow executes -
 * it reads as catastrophic, means nothing, and costs a full run (15-20
 * minutes) to discover. This costs milliseconds and runs in CI.
 *
 * Deliberately a scan rather than a real YAML parse: the app has no YAML
 * dependency and adding one to ship a test would be the wrong trade. The
 * scan reads command keys at list level, which is where the mistakes are.
 */

const FLOWS_DIR = join(__dirname, '..', '..', '.maestro');

/**
 * Commands the flows may use. Extend this deliberately: a name landing here
 * without having been run once against a device is how an untested command
 * reaches the suite.
 */
const KNOWN_COMMANDS = new Set([
  'launchApp',
  'tapOn',
  'longPressOn',
  'doubleTapOn',
  'inputText',
  'eraseText',
  'hideKeyboard',
  'back',
  'scroll',
  'scrollUntilVisible',
  'swipe',
  'assertVisible',
  'assertNotVisible',
  'assertTrue',
  'extendedWaitUntil',
  'waitForAnimationToEnd',
  'runFlow',
  'runScript',
  'repeat',
  'stopApp',
  'clearState',
  'openLink',
  'takeScreenshot',
  'pressKey',
  'travel',
  'setLocation',
  'evalScript',
  'copyTextFrom',
  'pasteText',
]);

function flowFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...flowFiles(full));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) found.push(full);
  }
  return found;
}

/** Command keys at list level: `- tapOn:` / `- back`, ignoring nested mapping keys. */
function commandsIn(source: string): string[] {
  const commands: string[] = [];
  for (const line of source.split('\n')) {
    const match = /^\s*-\s+([A-Za-z][A-Za-z0-9]*)\s*:?\s*$|^\s*-\s+([A-Za-z][A-Za-z0-9]*)\s*:\s+\S/.exec(line);
    if (match) commands.push(match[1] ?? match[2] ?? '');
  }
  return commands.filter((name) => name.length > 0);
}

describe('maestro flows', () => {
  const files = flowFiles(FLOWS_DIR);

  it('finds flows to check (a silent zero here would make every test below vacuous)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s uses only known Maestro commands', (file) => {
    const source = readFileSync(file, 'utf8');
    // Everything before the `---` is the app/env header, not commands.
    const body = source.includes('\n---') ? source.slice(source.indexOf('\n---') + 4) : source;
    const unknown = commandsIn(body).filter((name) => !KNOWN_COMMANDS.has(name));
    expect(unknown, `unknown command(s) in ${file}. A bad command name is a parse error that aborts the ENTIRE suite before any flow runs.`).toEqual([]);
  });

  it.each(files)('%s declares an appId', (file) => {
    expect(readFileSync(file, 'utf8')).toMatch(/^appId:/m);
  });

  /**
   * DELIBERATELY NOT CHECKED HERE: that every `id:` selector resolves to a
   * testID in src/.
   *
   * It was written, and removed after it flagged twelve VALID selectors. Most
   * testIDs are composed at runtime - `session-mode-chat` comes from
   * `${testIDPrefix}-${option.mode}` where the prefix arrives as a prop - so
   * the concrete string never appears in source at all, and a static scan
   * cannot tell that from a typo without evaluating the app.
   *
   * Left undone rather than tuned into an allowlist: a check that cries wolf
   * trains everyone to ignore it, which is worse than the gap it covers. The
   * failure it was aimed at (a selector that cannot resolve, failing at full
   * timeout rather than with an error) is caught instead by e2e-flow-doctor,
   * which reads the failure screenshot. If this becomes mechanical later, the
   * honest route is emitting a testID manifest from the app at build time and
   * checking flows against that - not guessing at template shapes.
   */

  it('actually locates the session-screen waits (guards the check below against passing vacuously)', () => {
    // Without this, a regex that stops matching - a reformat, a renamed id -
    // turns the timeout check into a test that passes by finding nothing.
    const total = files.reduce(
      (count, file) => count + [...readFileSync(file, 'utf8').matchAll(/id:\s*"session-screen"/g)].length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(6);
  });

  it.each(files)('%s waits at least 45s for the session screen', (file) => {
    // That screen mounts all three panes at once, terminal WebView included.
    // 20s held only on a warm emulator: it passed every warm run and failed
    // every cold one, twice, on two different flows.
    const source = readFileSync(file, 'utf8');
    const waits = [...source.matchAll(/id:\s*"session-screen"\s*\n(?:\s*#[^\n]*\n)*\s*timeout:\s*(\d+)/g)];
    for (const wait of waits) {
      expect(Number(wait[1]), `${file} waits ${wait[1]}ms for session-screen`).toBeGreaterThanOrEqual(45_000);
    }
  });
});
