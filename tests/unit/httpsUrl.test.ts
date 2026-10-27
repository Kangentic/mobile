/**
 * The one gate between a URL and the OS opener. Two callers feed it: a task's
 * desktop-sourced `pr_url`, and links tapped in markdown, which are
 * agent-authored and untrusted. Anything that is not https must come back
 * null, most of all the app's own `kangentic-pair://` and `kangentic://`
 * schemes, which would loop a transcript link into the deep-link router.
 */
import { describe, expect, it } from 'vitest';
import { httpsUrlOrNull } from '@/lib/httpsUrl';

describe('httpsUrlOrNull', () => {
  it('returns an https URL unchanged', () => {
    const url = 'https://github.com/Kangentic/kangentic/pull/656';
    expect(httpsUrlOrNull(url)).toBe(url);
  });

  it('reads the scheme case-insensitively and leaves the rest of the URL alone', () => {
    // Lowercasing the whole URL would break a case-sensitive path.
    const url = 'HTTPS://github.com/Kangentic/Kangentic/pull/656';
    expect(httpsUrlOrNull(url)).toBe(url);
  });

  it('rejects a missing URL', () => {
    expect(httpsUrlOrNull(null)).toBeNull();
    expect(httpsUrlOrNull(undefined)).toBeNull();
    expect(httpsUrlOrNull('')).toBeNull();
  });

  it('rejects a bare scheme with nothing after it', () => {
    expect(httpsUrlOrNull('https://')).toBeNull();
  });

  it.each([
    ['plain http', 'http://github.com/Kangentic/kangentic/pull/656'],
    ['the pairing deep link', 'kangentic-pair://demo'],
    ['the app scheme', 'kangentic://task/123'],
    ['javascript', 'javascript:alert(1)'],
    ['a local file', 'file:///etc/hosts'],
    ['a leading space', ' https://github.com'],
    ['https with no slashes', 'https:github.com'],
    ['a scheme that only starts with https', 'httpsx://github.com'],
  ])('rejects %s', (_description, url) => {
    expect(httpsUrlOrNull(url)).toBeNull();
  });
});
