/**
 * Parity between NotificationService.swift's `extractBlob(from:)` and
 * pushDecrypt.ts's `extractBlobFromTaskData`: the two places that pull the
 * sealed envelope's base64url blob out of an OS-delivered push payload.
 *
 * NO PR-GATING JOB EXERCISES THIS FUNCTION. "NSE crypto (swiftc)"
 * deliberately compiles only HChaCha20/PushEnvelope/CategoryCopy, per its own
 * comment in ci.yml, and nseConstantsParity.test.ts covers those same two
 * Swift files, not this one. `build-ios.yml`'s simulator job DOES compile
 * NotificationService.swift as part of the real Xcode target (confirmed in
 * run 33325523881's log), but that is dispatch-only, so it gates no merge -
 * and compiling proves the syntax, never the key names or their precedence.
 * There is no iOS test tier that could run the function at all.
 *
 * So this is exactly the kind of logic that fails SILENTLY: if the key names,
 * their precedence, or the nested-shape handling ever drift from what
 * Expo/APNs actually deliver, every iOS push degrades to the generic
 * placeholder with no crash and no red check anywhere.
 *
 * WHAT THIS DOES NOT PROVE: this pins key names, precedence, and the
 * documented TS/Swift SUPERSET relationship as source text, not behavior. It
 * cannot catch a wrong APNs payload shape in production, nor a bug inside
 * blobFromJsonString or JSON.parse - only compiling and exercising
 * NotificationService.swift (or a real device) could do that. Read
 * targets/nse/NotificationService.swift's own header comment on
 * `extractBlob` before touching this file: it explains why the
 * nested-dictionary branch is a deliberate, permanent superset over the
 * TypeScript, not drift to "reconcile" away.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const notificationServiceSwift = readFileSync(
  join(__dirname, '..', '..', 'targets', 'nse', 'NotificationService.swift'),
  'utf8',
);

/**
 * Read as text rather than imported, same technique and reason as
 * nseConstantsParity.test.ts and secureStoreKeychainLayout.test.ts:
 * pushDecrypt.ts reaches SecureStore on the way, so importing it would drag
 * the React Native runtime into this plain-Node tier.
 */
const pushDecryptTypeScript = readFileSync(
  join(__dirname, '..', '..', 'src', 'notifications', 'pushDecrypt.ts'),
  'utf8',
);

/**
 * Source with `//`, doc-comment (`///`, `/**`) and block-comment
 * continuation lines removed, applied to BOTH languages' source. Line
 * comments and JSDoc/Swift-doc blocks share the same shape (`//...` or a
 * `*`-prefixed continuation line), so one filter covers both.
 *
 * Load bearing, not cosmetic: this file's own header, and pushDecrypt.ts's
 * doc comment on extractBlobFromTaskData, both name "blob", "dataString" and
 * "body" in prose - in that exact order - so an assertion that read the raw
 * text could stay green after the CODE'S precedence was reversed. That is
 * not hypothetical; it happened writing this file's precedence test, against
 * pushDecrypt.ts's own doc comment at the top of extractBlobFromTaskData.
 *
 * WHOLE-LINE COMMENTS ONLY, same limitation buildWorkflow.test.ts's own
 * withoutComments accepts. A trailing comment on a code line
 * (`const x = 1; // dataString before body`) is not stripped and could
 * reopen this exact hole. Keep any future precedence comment on its own
 * line, not trailing the code it describes.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

const swiftCode = withoutComments(notificationServiceSwift);
const typeScriptCode = withoutComments(pushDecryptTypeScript);

describe('NSE payload-shape parity: extractBlob vs extractBlobFromTaskData', () => {
  it('checks the top-level "blob" string field first, on both sides', () => {
    expect(swiftCode).toContain('userInfo["blob"] as? String');
    expect(typeScriptCode).toContain("typeof data.blob === 'string'");
  });

  it('prefers "dataString" over "body" for the nested envelope, on both sides', () => {
    // One ordered array literal drives both the Swift dictionary branch and
    // the Swift JSON-string branch, so this one assertion covers both.
    expect(swiftCode).toContain('for key in ["dataString", "body"]');

    // The TypeScript side's own precedence, not a restated literal: if
    // pushDecrypt.ts's fallback ternary ever reversed dataString and body,
    // this must fail too, not merely confirm both strings exist somewhere.
    // Comments stripped above, or the doc comment naming both keys in prose
    // (in this same order) would make this pass vacuously - confirmed by
    // mutating the code order with the comment left in place.
    //
    // Matched against the full `typeof data.X === 'string'` guard, not the
    // bare `data.dataString`/`data.body` substring: a bare substring would
    // also match an unrelated field added earlier in the file (a future
    // `data.bodyRaw`, say), which would satisfy the index comparison without
    // actually pinning the ternary's precedence.
    const dataStringIndex = typeScriptCode.indexOf("typeof data.dataString === 'string'");
    const bodyIndex = typeScriptCode.indexOf("typeof data.body === 'string'");
    expect(dataStringIndex).toBeGreaterThan(-1);
    expect(bodyIndex).toBeGreaterThan(-1);
    expect(dataStringIndex).toBeLessThan(bodyIndex);
  });

  it('keeps the nested-DICTIONARY branch the TypeScript deliberately does not have', () => {
    // expo-notifications hands JS an already-unwrapped `data` object, so the
    // TS side never encounters userInfo's raw nested-dictionary shape - only
    // the extension reads the untouched APNs payload. Deleting this branch to
    // "match" the TypeScript would be the regression, not a fix.
    expect(swiftCode).toContain('userInfo[key] as? [AnyHashable: Any]');
    expect(swiftCode).toContain('nested["blob"] as? String');
  });

  it('falls back to parsing the nested value as a JSON string, on both sides', () => {
    expect(swiftCode).toContain('userInfo[key] as? String');
    expect(swiftCode).toContain('blobFromJsonString(nestedJson)');
    expect(typeScriptCode).toContain('JSON.parse(nestedJson)');
    expect(typeScriptCode).toContain('parsed.blob');
  });
});
