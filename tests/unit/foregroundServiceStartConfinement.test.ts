/**
 * The dataSync foreground service has exactly one start path, and that path
 * arms the native stop alarm.
 *
 * Sentry MOBILE-3 recurred on 0.8.0+13, and the fix is a native AlarmManager
 * stop armed immediately before every service start (modules/
 * foreground-service-guard). That is only a bound if EVERY start arms it. notifee
 * starts its foreground service from exactly one JS call shape, a notification
 * with `android.asForegroundService: true`, whether that goes through
 * displayNotification or a trigger notification. So this scan's invariant is
 * that `asForegroundService` appears in one file only:
 * src/notifications/foregroundService.ts, whose startConnectedForegroundService
 * arms the alarm before it displays. tests/unit/foregroundService.test.ts pins
 * that arm, and its ordering, behaviourally.
 *
 * The audit behind this (task #104), so nobody has to repeat it: the headless
 * push task (backgroundPushTask.ts) posts without the flag and cannot start the
 * service. plugins/withAndroidPushService.ts only declares the service type in
 * the manifest. A sticky restart is not a start path either, because notifee
 * 9.1.8's onStartCommand returns START_NOT_STICKY (read from the bytecode).
 *
 * A future second start path, such as a scheduled trigger or a new keepalive,
 * fails here until it either goes through startConnectedForegroundService or
 * arms the alarm itself and joins the allowlist below with a test of its own.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const THE_START_PATH = 'src/notifications/foregroundService.ts';

const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

function collectSourceFiles(directory: string, collected: string[]): void {
  if (!existsSync(path.join(repoRoot, directory))) return;
  for (const entry of readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      collectSourceFiles(relativePath, collected);
    } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      collected.push(relativePath);
    }
  }
}

function sourceFiles(): string[] {
  const collected: string[] = [];
  collectSourceFiles('src', collected);
  collectSourceFiles('app', collected);
  collectSourceFiles('modules', collected);
  // The bundle entry, which registers notification handlers at module scope.
  if (existsSync(path.join(repoRoot, 'index.js'))) collected.push('index.js');
  return collected;
}

function filesStartingTheService(): string[] {
  return sourceFiles().filter((relativePath) =>
    /\basForegroundService\b/.test(readFileSync(path.join(repoRoot, relativePath), 'utf8')),
  );
}

describe('foreground service start confinement', () => {
  it('finds source files to scan at all', () => {
    // A scan that silently matches nothing would make the assertions below
    // vacuously true.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it('starts the foreground service from foregroundService.ts and nowhere else', () => {
    // Both halves matter. Without the first, renaming the start site away would
    // leave this passing over zero start paths. Without the second, a new start
    // path elsewhere would ship with no alarm behind it.
    //
    // Mutation seen failing: adding `asForegroundService: true` to the headless
    // push task's placeholder display made this receive
    // "src/notifications/backgroundPushTask.ts" as a second entry.
    expect(filesStartingTheService()).toEqual([THE_START_PATH]);
  });
});
