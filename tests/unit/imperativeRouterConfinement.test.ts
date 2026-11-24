/**
 * expo-router's imperative `router` singleton must only be reached from code
 * that renders inside the mounted root navigator, and no router's `setParams`
 * may be called from anywhere.
 *
 * `router.push`/`navigate` do not navigate. They append to a queue held in React
 * state and return. Since SDK 58 the singleton THROWS until the navigation
 * container commits, and a failure draining the queue is only a console.warn, so
 * a stray call fails at the call site or is silently lost. Through SDK 57 the
 * drain itself threw, above every route error boundary, and aborted the process:
 * the iOS TestFlight cold-start crash on 0.6.3 build 13, reached by a
 * notification tap.
 *
 * WHY A SCAN AND NOT JUST THE LINT RULE. `eslint.config.mjs` bans the static
 * `import { router } from 'expo-router'` outside the allowed directories, but
 * `no-restricted-imports` matches import SYNTAX only - never `require()` and
 * never a dynamic `import()`. That is not hypothetical here: the second live
 * instance of this bug, in `connectionManager.ts`, reached the router via
 * `await import('expo-router')` and would have sailed past the lint rule
 * completely. The same hole is already documented for the Sentry ban in
 * `.claude/rules/crash-reporting-scope.md`.
 *
 * See `.claude/rules/imperative-router-inside-react.md`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Everything in these directories renders inside the mounted root navigator,
 * which is the condition that makes a router call safe. Keep this list in step
 * with the allow entry in eslint.config.mjs.
 */
const ALLOWED_DIRECTORIES = ['src/screens/', 'src/components/', 'src/navigation/'];

/** Any non-static route to the module: require() or a dynamic import(). */
const DYNAMIC_ROUTES = [/require\(\s*['"]expo-router['"]\s*\)/, /import\(\s*['"]expo-router['"]\s*\)/];

/**
 * `setParams` reached through a router: the exported singleton or the object
 * `useRouter()` returns, called on either or destructured from either. Relies on
 * the house name for that object (`const router = useRouter()`), reads comments
 * as code, and leaves `navigation.setParams(...)`, the call to make instead, alone.
 */
const ROUTER_SET_PARAMS = [
  /\brouter\s*\??\.\s*setParams\b/,
  /\buseRouter\(\s*\)\s*\??\.\s*setParams\b/,
  /\{[^{}]*\bsetParams\b[^{}]*\}\s*=\s*(?:useRouter\(\s*\)|router\b)/,
];

function reachesRouterSetParams(source: string): boolean {
  return ROUTER_SET_PARAMS.some((pattern) => pattern.test(source));
}

function collectSourceFiles(directory: string, collected: string[]): void {
  for (const entry of readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const relativePath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      collectSourceFiles(relativePath, collected);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      collected.push(relativePath);
    }
  }
}

function sourceFiles(): string[] {
  const collected: string[] = [];
  collectSourceFiles('src', collected);
  collectSourceFiles('app', collected);
  return collected;
}

function isAllowed(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  return ALLOWED_DIRECTORIES.some((directory) => normalized.startsWith(directory));
}

describe('imperative router confinement', () => {
  it('finds source files to scan at all', () => {
    // Guards the scan itself: a glob that silently matches nothing would make
    // every assertion below vacuously true.
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it('never reaches expo-router through require() or a dynamic import() outside the navigator directories', () => {
    const offenders = sourceFiles()
      .filter((relativePath) => !isAllowed(relativePath))
      .filter((relativePath) => {
        const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
        return DYNAMIC_ROUTES.some((pattern) => pattern.test(source));
      });

    expect(offenders).toEqual([]);
  });

  /**
   * Belt and braces over the lint rule, so the invariant survives someone
   * reordering eslint.config.mjs and silently dropping the ban (a documented
   * trap in that file: flat config REPLACES a rule's options rather than
   * merging them).
   */
  it('never statically imports the router singleton outside the navigator directories', () => {
    const staticRouterImport = /import\s*\{[^}]*\brouter\b[^}]*\}\s*from\s*['"]expo-router['"]/;
    const offenders = sourceFiles()
      .filter((relativePath) => !isAllowed(relativePath))
      .filter((relativePath) => {
        const source = readFileSync(path.join(repoRoot, relativePath), 'utf8');
        return staticRouterImport.test(source);
      });

    expect(offenders).toEqual([]);
  });
});

/**
 * Sentry MOBILE-K. `setParams` is the one navigating method expo-router 58 does
 * not queue: it throws at the call site while the module-level navigation ref is
 * null, and that happened under a mounted, focused screen. `useRouter()` is no
 * protection, because its `setParams` is the same function.
 *
 * EVERY file is scanned, the navigator directories included: the call that
 * crashed was in src/screens, which renders inside the navigator and is exempt
 * from everything above.
 *
 * Mutation seen failing: the call as it shipped in CommandTerminalScreen.tsx,
 * which the scan names.
 */
describe("a router's setParams", () => {
  it.each([
    ["the singleton, or the hook's object", 'router.setParams({ sessionId });'],
    ['an optional call', 'router?.setParams({ sessionId });'],
    ["the hook's object inline", 'useRouter().setParams({ sessionId });'],
    ['destructured from the hook', 'const { setParams } = useRouter();'],
    ['destructured beside others', 'const { back, setParams: writeParams } = router;'],
  ])('is matched as %s (or the scan below proves nothing)', (_shape, source) => {
    expect(reachesRouterSetParams(source)).toBe(true);
  });

  it.each([
    ["the screen's own navigation object", 'navigation.setParams({ sessionId });'],
    ['useNavigation inline', 'useNavigation().setParams({ sessionId });'],
    ['the other router methods', 'const { back, canGoBack } = useRouter(); router.back();'],
    ['a type that names it', 'useNavigation<{ setParams(params: RouteParams): void }>();'],
  ])('is not matched as %s', (_shape, source) => {
    expect(reachesRouterSetParams(source)).toBe(false);
  });

  it('is called nowhere in src or app', () => {
    const offenders = sourceFiles().filter((relativePath) =>
      reachesRouterSetParams(readFileSync(path.join(repoRoot, relativePath), 'utf8')),
    );

    expect(offenders).toEqual([]);
  });
});
