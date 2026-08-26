import { DEMO_DEEP_LINK_PARAM, isDemoPairingCode } from '@/demo/demoIdentity';

/**
 * Deep-link handling, deliberately scoped to the reviewer/demo code and nothing
 * else.
 *
 * `redirectSystemPath` receives the RAW incoming URL as `path` (expo-router
 * passes `Linking`'s url straight through), so `kangentic-pair://demo` arrives
 * here verbatim and matches the same predicate the camera and paste field use.
 *
 * WHY REAL PAIRING URIs ARE NOT HANDLED HERE. A `kangentic-pair://<payload>`
 * link carries an attacker-chosen desktop key AND relay address, and pairing
 * pins both for every later session, so honouring one from an arbitrary web
 * page or message would let a link start a ceremony against a host the user
 * never saw. That is a real capability with its own threat model and it is
 * parked as a later phase in docs/architecture.md; nothing about shipping a
 * demo requires pulling it forward. The demo link is safe precisely because it
 * carries no attacker-controlled data at all: it is a compile-time constant,
 * it is refused when the phone is already paired, and it can only ever show
 * fixture content.
 *
 * Returning `path` unchanged is the no-op: real pairing URIs still match no
 * route and are ignored exactly as they are today.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (isDemoPairingCode(path)) return `/pair?${DEMO_DEEP_LINK_PARAM}=1`;
  } catch {
    // The contract warns that throwing here can crash the app on launch, and
    // this runs before any error boundary exists. Falling through to the
    // unchanged path is always safe.
  }
  return path;
}
