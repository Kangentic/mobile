/**
 * The command-line shape the release scripts share: `--flag value` pairs and
 * nothing else.
 *
 * Strict on purpose. A bare flag would silently swallow the next flag as its
 * value, and these scripts decide what reaches a store, so a malformed command
 * line stops before the first call. Each script layers its own required
 * arguments and modes on top of the pairs this returns.
 */

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {Record<string, string>} each flag, without its dashes, to its value
 */
export function parseFlagPairs(argv) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`Malformed argument near "${flag}".`);
    }
    parsed[flag.slice(2)] = value;
  }
  return parsed;
}
