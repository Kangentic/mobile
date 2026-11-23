import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The bash that the unit tests which execute shell scripts run them with.
 *
 * On Windows, `bash` on PATH is usually WSL's, which cannot open a `C:/...` path
 * at all and fails with a "No such file or directory" that looks like a missing
 * file rather than a wrong interpreter. Git Bash can, and is what the rest of the
 * repository's tooling uses. Paths are derived from the environment rather than
 * hardcoded (.claude/rules/no-personal-info.md). `KANGENTIC_BASH` overrides the
 * search for a Git install elsewhere.
 *
 * Returns null when no usable bash is found, so a suite can `describe.skipIf` on
 * it and a Windows developer without Git Bash sees why. The ubuntu runner that
 * hosts the unit tier always has bash.
 */
export function resolveBashExecutable(): string | null {
  if (process.platform !== 'win32') {
    return 'bash';
  }
  const candidates = [
    process.env.KANGENTIC_BASH,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
