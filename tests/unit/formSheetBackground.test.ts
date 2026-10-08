/**
 * Guards the form sheets against a two-tone bottom on iOS.
 *
 * Every sheet screen paints its content `theme.colors.surfaceOverlay`, but the
 * native sheet container underneath took the root stack's `contentStyle`
 * (`theme.colors.background`). On iOS the sheet runs past its content into the
 * bottom safe-area inset, so that strip showed as a darker band under the form
 * inside the rounded sheet: seen on the iOS 26 simulator in the Show sections
 * sheet's capture (build-ios.yml run 37762257011, 2026-10-08). The shared
 * `formSheetOptions` in app/_layout.tsx now set the container to the same
 * surface, and this keeps the container and every sheet screen on one colour,
 * so neither side can move without the other.
 *
 * A static read rather than a render: the band only exists in a native iOS
 * sheet, which no JS tier can draw, so the test pins the colour agreement that
 * removes it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const rootLayoutSource = readFileSync(`${repositoryRoot}app/_layout.tsx`, 'utf8');

/** The `formSheetOptions` object literal, with comments stripped. */
function readFormSheetOptions(): string {
  const match = /const formSheetOptions = \{([\s\S]*?)\} as const;/.exec(rootLayoutSource);
  expect(match, 'app/_layout.tsx still declares formSheetOptions').not.toBeNull();
  return (match?.[1] ?? '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Route names registered with the shared sheet options. */
function readSheetRouteNames(): string[] {
  return [...rootLayoutSource.matchAll(/<Stack\.Screen\s+name="([^"]+)"\s+options=\{formSheetOptions\}\s*\/>/g)].map(
    (match) => match[1],
  );
}

/** The screen file each sheet route renders, by the repo's naming: `create-task` -> CreateTaskScreen. */
function screenSourceFor(routeName: string): string {
  const componentName = `${routeName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}Screen`;
  return readFileSync(`${repositoryRoot}src/screens/${componentName}.tsx`, 'utf8');
}

describe('form sheet background', () => {
  it('paints the native sheet container the surface every sheet screen paints', () => {
    const options = readFormSheetOptions();
    expect(options).toMatch(/contentStyle:\s*\{\s*backgroundColor:\s*theme\.colors\.surfaceOverlay\s*\}/);
  });

  it('finds the sheet routes at all', () => {
    // Non-vacuity guard: the per-screen check below must have screens to check.
    expect(readSheetRouteNames().length).toBeGreaterThanOrEqual(6);
  });

  it.each(readSheetRouteNames())('the %s sheet screen paints its content that same surface', (routeName) => {
    expect(screenSourceFor(routeName)).toMatch(/backgroundColor:\s*theme\.colors\.surfaceOverlay/);
  });
});
