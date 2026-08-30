/**
 * Parity between the iOS Notification Service Extension's Swift constants and
 * the TypeScript they duplicate.
 *
 * The extension is a separate process with no access to the JS bundle, so the
 * category titles and the envelope freshness window have to exist twice. There
 * is no iOS test tier in this project, so without this file the two copies
 * could drift a string at a time and the only symptom would be an iPhone
 * notification worded differently from the Android one, or a freshness window
 * that quietly stopped matching the protocol.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUSH_CATEGORIES, PUSH_ENVELOPE_MAX_AGE_MS, PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS } from '@kangentic/protocol';
import { titleForCategory } from '@/notifications/categoryCopy';

const targetsDir = join(__dirname, '..', '..', 'targets', 'nse');
const categoryCopySwift = readFileSync(join(targetsDir, 'CategoryCopy.swift'), 'utf8');
const pushEnvelopeSwift = readFileSync(join(targetsDir, 'PushEnvelope.swift'), 'utf8');

/**
 * Read as text rather than imported: decryptPushBlob composes the body inline
 * and reaches SecureStore on the way, so importing it would drag the React
 * Native runtime into this plain-Node tier. Same technique, and same reason, as
 * secureStoreKeychainLayout.test.ts reading the vendored Swift.
 */
const pushDecryptTypeScript = readFileSync(
  join(__dirname, '..', '..', 'src', 'notifications', 'pushDecrypt.ts'),
  'utf8',
);

/** Pulls `case "<category>": return "<title>"` pairs out of the Swift switch. */
function swiftCategoryTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  const pattern = /case "([a-z-]+)":\s*return "([^"]+)"/g;
  let match = pattern.exec(categoryCopySwift);
  while (match !== null) {
    titles.set(match[1], match[2]);
    match = pattern.exec(categoryCopySwift);
  }
  return titles;
}

describe('NSE category copy parity', () => {
  it('covers every push category the protocol defines', () => {
    // A category added to the protocol but not here would fall through to the
    // default branch and show the placeholder forever on iOS.
    const titles = swiftCategoryTitles();
    expect([...titles.keys()].sort()).toEqual([...PUSH_CATEGORIES].sort());
  });

  it('uses the exact same title string as titleForCategory for each category', () => {
    const titles = swiftCategoryTitles();
    for (const category of PUSH_CATEGORIES) {
      expect(titles.get(category)).toBe(titleForCategory(category));
    }
  });

  it('composes the body the same way decryptPushBlob does', () => {
    // "<taskTitle> - <detail>", the bare title when detail is empty, and the
    // same "Agent session" fallback for an empty task title.
    expect(categoryCopySwift).toContain('taskTitle.isEmpty ? "Agent session" : taskTitle');
    expect(categoryCopySwift).toContain('detail.isEmpty ? resolvedTitle : "\\(resolvedTitle) - \\(detail)"');

    // BOTH sides, or this proves nothing. Asserting only the Swift literals
    // makes this a Swift self-check that still passes after the TypeScript
    // changes its separator or its empty-title fallback, which is precisely the
    // drift the header claims this file catches.
    expect(pushDecryptTypeScript).toContain("plaintext.taskTitle.length > 0 ? plaintext.taskTitle : 'Agent session'");
    expect(pushDecryptTypeScript).toContain('`${taskTitle} - ${plaintext.detail}`');
  });
});

describe('NSE push envelope constants parity', () => {
  it('hardcodes the protocol freshness window', () => {
    // Both are root-exported from @kangentic/protocol, so a change there is a
    // one-line change here, and this test is what makes it a loud one.
    const maximumAge = /maximumAgeMilliseconds: Double = ([0-9 *]+)/.exec(pushEnvelopeSwift);
    const maximumSkew = /maximumFutureSkewMilliseconds: Double = ([0-9 *]+)/.exec(pushEnvelopeSwift);
    expect(maximumAge).not.toBeNull();
    expect(maximumSkew).not.toBeNull();

    const evaluate = (expression: string): number =>
      expression
        .split('*')
        .map((term) => Number(term.trim()))
        .reduce((product, term) => product * term, 1);

    expect(evaluate((maximumAge as RegExpExecArray)[1])).toBe(PUSH_ENVELOPE_MAX_AGE_MS);
    expect(evaluate((maximumSkew as RegExpExecArray)[1])).toBe(PUSH_ENVELOPE_MAX_FUTURE_SKEW_MS);
  });

  it('checks freshness after decrypting, because sentAt is inside the sealed JSON', () => {
    // There is no top-level sentAt in the OS-visible payload. An implementation
    // that read one would get nil and silently stop enforcing the window.
    const decryptIndex = pushEnvelopeSwift.indexOf('XChaCha20Poly1305.open');
    expect(decryptIndex).toBeGreaterThan(-1);
    expect(pushEnvelopeSwift.indexOf('nowMilliseconds - maximumAgeMilliseconds')).toBeGreaterThan(decryptIndex);
  });
});
