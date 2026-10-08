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
 * removes it. Both sides are read with comments stripped, so a colour that
 * survives only in a comment cannot satisfy a check. The route list is
 * cross-checked against every `formSheetOptions` reference and every
 * `presentation: 'formSheet'` in the layout, so a sheet registered in a form
 * the route parser cannot read fails loudly instead of dropping out of the
 * per-screen loop.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One alternation, scanned left to right: a string or template literal (kept
 * as is), a block comment, or a line comment. Matching literals first is what
 * keeps the `//` in `'https://'` from reading as a comment start, and scanning
 * in one pass keeps a `//` inside a block comment, or a block-comment opener
 * inside a line comment, from derailing the strip.
 */
const commentOrStringLiteralPattern =
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/**
 * Source with its comments removed. A regex scan, not a parser, with one
 * known blind spot: a lone apostrophe in JSX text can pair with the opening
 * quote of a later string on the same line, and that string's body is then
 * scanned as code, so a `//` inside it would eat the rest of the line. The
 * layout and the six sheet screens read here contain no such line (the
 * `HTTPS_SCHEME` literal in TaskActionsScreen survives intact), but a future
 * edit could add one and hide a match from the checks below.
 */
function stripComments(source: string): string {
  return source.replace(commentOrStringLiteralPattern, (_match, stringLiteral: string | undefined) => stringLiteral ?? '');
}

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const rootLayoutSource = stripComments(readFileSync(`${repositoryRoot}app/_layout.tsx`, 'utf8'));

/** The `formSheetOptions` object literal. */
function readFormSheetOptions(): string {
  const match = /const formSheetOptions = \{([\s\S]*?)\} as const;/.exec(rootLayoutSource);
  expect(match, 'app/_layout.tsx still declares formSheetOptions').not.toBeNull();
  return match?.[1] ?? '';
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
  return stripComments(readFileSync(`${repositoryRoot}src/screens/${componentName}.tsx`, 'utf8'));
}

const sheetRouteNames = readSheetRouteNames();

describe('stripComments', () => {
  it('keeps a URL scheme inside a string literal and drops a trailing line comment', () => {
    const source = "const HTTPS_SCHEME = 'https://'; // backgroundColor: theme.colors.surfaceOverlay";
    expect(stripComments(source)).toBe("const HTTPS_SCHEME = 'https://'; ");
  });

  it('drops a block comment holding a line-comment marker and a line comment holding a block opener, keeping the code after both', () => {
    const source = ['/* first // second */ const kept = 1;', '// third /* fourth', 'const alsoKept = 2;'].join('\n');
    expect(stripComments(source)).toBe(' const kept = 1;\n\nconst alsoKept = 2;');
  });
});

describe('form sheet background', () => {
  it('paints the native sheet container the surface every sheet screen paints', () => {
    const options = readFormSheetOptions();
    expect(options).toMatch(/contentStyle:\s*\{\s*backgroundColor:\s*theme\.colors\.surfaceOverlay\s*\}/);
  });

  it('finds the sheet routes at all', () => {
    // Non-vacuity guard: the per-screen check below must have screens to check.
    expect(sheetRouteNames.length).toBeGreaterThanOrEqual(6);
  });

  it('reads every route registered with formSheetOptions', () => {
    // The route parser only reads the plain `<Stack.Screen name="..." options={formSheetOptions} />`
    // form. A sheet registered as `options={{ ...formSheetOptions, x }}`, with the braces split
    // across lines, or with its attributes reordered would drop out of the per-screen loop
    // silently, so every reference to formSheetOptions has to be a route the parser found.
    const declarationCount = rootLayoutSource.match(/\bconst formSheetOptions\b/g)?.length ?? 0;
    const referenceCount = (rootLayoutSource.match(/\bformSheetOptions\b/g)?.length ?? 0) - declarationCount;
    expect(declarationCount, 'app/_layout.tsx declares formSheetOptions once').toBe(1);
    expect(referenceCount, 'every formSheetOptions reference is a route readSheetRouteNames parses').toBe(
      sheetRouteNames.length,
    );
  });

  it('declares presentation formSheet only inside formSheetOptions', () => {
    // A formSheet route that bypasses formSheetOptions never shows up as a reference above, so
    // count the presentation itself: the one occurrence has to be the shared options' own.
    expect(readFormSheetOptions()).toMatch(/presentation:\s*['"]formSheet['"]/);
    const presentationCount = rootLayoutSource.match(/presentation:\s*['"]formSheet['"]/g)?.length ?? 0;
    expect(presentationCount, 'app/_layout.tsx sets presentation formSheet only in formSheetOptions').toBe(1);
  });

  it.each(sheetRouteNames)('the %s sheet screen paints its content that same surface', (routeName) => {
    expect(screenSourceFor(routeName)).toMatch(/backgroundColor:\s*theme\.colors\.surfaceOverlay/);
  });
});
