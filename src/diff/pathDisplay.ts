/**
 * Splitting a repo-relative (or absolute) file path into the directory
 * prefix and the basename, for the two-tone path rendering in the diff file
 * list. Tolerant of both forward slashes and backslashes because the desktop
 * may run on Windows.
 */

export interface SplitPathForDisplayResult {
  /** Directory prefix including the trailing separator, or '' for a bare filename. */
  directory: string;
  basename: string;
}

export function splitPathForDisplay(path: string): SplitPathForDisplayResult {
  const lastSeparatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0) {
    return { directory: '', basename: path };
  }
  return {
    directory: path.slice(0, lastSeparatorIndex + 1),
    basename: path.slice(lastSeparatorIndex + 1),
  };
}
