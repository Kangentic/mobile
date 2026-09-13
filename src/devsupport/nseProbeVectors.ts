/**
 * The NSE probe's known vectors, and its build-time gate.
 *
 * `build-ios.yml -f nse_probe=true` proves that the iOS Notification Service
 * Extension decrypts a push on a CI simulator: the app seeds these two vectors
 * into the shared Keychain (through the production write path), the runner
 * seals a push with the same vectors, `simctl push`es it, and the app reads
 * back what the OS displayed. A delivered notification alone cannot prove the
 * extension ran, because the placeholder renders on every failure by design
 * (.claude/rules/e2e-notification-privacy.md); a changed title can only come
 * from a decrypt.
 *
 * PUBLIC TEST DATA, not secrets. The vectors are duplicated as literals in
 * scripts/sealNseProbePush.mjs (plain Node cannot import this TypeScript), and
 * tests/unit/nseProbe.test.ts pins the two copies equal - the same
 * duplicated-constant pattern as the Swift category copy. This module is kept
 * pure (no notifee, no SecureStore) so that test can import it in the
 * plain-Node tier.
 *
 * Gated like the crash-test rig: `EXPO_PUBLIC_*` is inlined at bundle time, so
 * the probe is inert in every build not dispatched with the flag on, and
 * build-ios.yml refuses the flag together with a TestFlight submission.
 *
 * INERT IS NOT ABSENT, and the difference matters for what the gates are worth.
 * This module has no `__DEV__` guard and no dynamic-import boundary (both
 * deliberate: the probe has to build Release), so Metro strips nothing. These
 * two literals and the whole seeding path ship inside a store binary with
 * `nseProbeEnabled()` merely returning false at runtime - unlike
 * connectionManager's mock peer, which IS stripped because it sits behind
 * `__DEV__ && await import(...)`.
 *
 * The stakes are higher than the crash-test flag's: a real install running with
 * this flag on would have a push channel keyed by a PUBLIC value. So count the
 * gates honestly, strongest first:
 *
 * 1. CI - the flag is exported only by the simulator job (the device job has no
 *    probe branch), and refusal steps at the top of both build jobs and in
 *    submit-testflight reject a probe build that also submits.
 * 2. Runtime - `nseProbeEnabled()` is checked both by the Settings row that
 *    renders the affordance and, load-bearingly, by `seedNseProbe()` itself,
 *    so the seeding path refuses regardless of who calls it.
 *
 * `seedSharedPushKeysForProbe`'s missing-shared-group throw is NOT a third
 * gate: build-ios.yml exports EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP on the
 * signed device path too (the NSE needs it), so `usesSharedKeychain()` is true
 * in exactly the build where a gate would matter. It guards against writing
 * somewhere the extension cannot read, which is a different failure.
 *
 * Loosening any of the above is a security change, not a convenience.
 */
export const NSE_PROBE_PUSH_KEY_HEX = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
export const NSE_PROBE_IDENTITY_PUBLIC_KEY_HEX = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

/** Read at call time, not import time, so a test can flip it the way the crash-test tests do. */
export function nseProbeEnabled(): boolean {
  return process.env.EXPO_PUBLIC_KANGENTIC_NSE_PROBE === '1';
}
