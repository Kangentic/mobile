const HTTPS_SCHEME = 'https://';

/**
 * Only ever hand `https` to the OS opener. Returns the URL unchanged when it
 * passes, `null` otherwise.
 *
 * Two kinds of URL reach an opener. A task's `pr_url` comes from the paired
 * desktop, which is trusted, so there this is not the load-bearing control -
 * but "trusted source" is exactly the reasoning that turns an opener into a
 * gadget the day some other path can write that column. A link tapped in
 * markdown is agent-authored text and is untrusted outright. A
 * `kangentic-pair://` or `kangentic://` link in a transcript would loop back
 * into the app's own deep-link router, which `app/+native-intent.ts`
 * deliberately limits to the demo code; `javascript:`, `file:` and plain
 * `http:` have no business reaching the OS either.
 *
 * Deliberately a string comparison rather than `new URL()`, for the reason
 * `isSecureRelayAddress` in `src/pairing/qr.ts` gives: Hermes ships a partial
 * URL implementation and React Native's polyfill situation varies by SDK, so a
 * check whose verdict depends on which parser is present at runtime would be
 * worse than a fixed prefix comparison. Jest runs on Node's complete URL, so
 * that difference would never have shown up in a test.
 */
export function httpsUrlOrNull(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  // The scheme is case-insensitive, the rest of the URL is not.
  if (!url.toLowerCase().startsWith(HTTPS_SCHEME)) return null;
  return url.length > HTTPS_SCHEME.length ? url : null;
}
