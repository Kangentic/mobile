/**
 * Undo Git Bash's (MSYS) path conversion on one CLI argument.
 *
 * MSYS rewrites any argument that looks like a POSIX path before a native
 * Windows program sees it, so `node scripts/mobileInspect.mjs text "/pause"`
 * reaches the script as `C:/Program Files/Git/pause`, and the app receives that
 * string instead of the command. Observed 2026-10-07 typing a mock chat command
 * into the composer. The rewrite prefixes the MSYS root, which is the Git
 * install folder (Git Bash exports it as EXEPATH, `...\Git\bin`), so stripping
 * that exact prefix restores what was typed. A value not under the root is
 * returned unchanged, and outside Git Bash (no MSYSTEM) nothing is touched.
 *
 * @param {string} value
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function undoMsysPathConversion(value, env = process.env) {
  if (!env.MSYSTEM || !env.EXEPATH) return value;
  const root = msysRootFrom(env.EXEPATH);
  const lowerValue = value.toLowerCase();
  const lowerRoot = root.toLowerCase();
  if (lowerValue === lowerRoot) return '/';
  return lowerValue.startsWith(`${lowerRoot}/`) ? value.slice(root.length) : value;
}

/**
 * Whether a value still looks like a path MSYS produced: Git Bash is running
 * and the value starts with a drive letter. Used to warn when the root could
 * not be read (no EXEPATH) and the rewrite therefore could not be undone.
 *
 * @param {string} value
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function looksMsysConverted(value, env = process.env) {
  return Boolean(env.MSYSTEM) && /^[A-Za-z]:\//.test(value);
}

/** `C:\Program Files\Git\bin` (or `...\usr\bin`) becomes `C:/Program Files/Git`. */
function msysRootFrom(exePath) {
  return exePath
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/\/(usr\/)?bin$/i, '');
}
