/**
 * The environment the Expo commands in scripts/checkExpoDrift.mjs and scripts/fixExpoDrift.mjs
 * run in: this process's, without EXPO_OFFLINE. ci.yml's required drift step sets that variable
 * to read only the installed SDK's own list, and a shell or runner that carries it would turn the
 * daily live check, or the fix's final check, into that offline variant without saying so.
 *
 * Its own module so the daily check does not load the fix script, and through it
 * scripts/upgrade-deps.mjs and its dependencies, for three lines.
 *
 * @param {Record<string, string | undefined>} baseEnvironment
 * @returns {Record<string, string | undefined>}
 */
export function onlineEnvironment(baseEnvironment) {
  const environment = { ...baseEnvironment };
  delete environment.EXPO_OFFLINE;
  return environment;
}
