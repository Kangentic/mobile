/**
 * The coupling guard between targets/nse/SharedKeychain.swift and
 * expo-secure-store's PRIVATE Keychain query layout.
 *
 * The app writes the push decrypt key through `SecureStore.setItemAsync`, and
 * the Notification Service Extension reads it with a raw
 * `SecItemCopyMatching`. That only works while the extension reproduces the
 * exact query expo-secure-store builds, and that layout is an implementation
 * detail of a package this repo upgrades routinely.
 *
 * WHY THIS DESERVES A TEST RATHER THAN A COMMENT: if the layout drifts, nothing
 * fails. The extension still builds, still runs, still delivers a notification.
 * The Keychain read simply returns errSecItemNotFound and every push degrades
 * to the generic placeholder, which is indistinguishable from an extension that
 * was never installed. There is no iOS test tier to catch it and no crash to
 * point at. A red unit test on Windows is the only affordable signal.
 *
 * If this test fails after an `expo install`, do NOT relax it. Read the new
 * `query(with:options:)` and update SharedKeychain.swift to match.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const vendoredModuleSwift = readFileSync(
  join(__dirname, '..', '..', 'node_modules', 'expo-secure-store', 'ios', 'SecureStoreModule.swift'),
  'utf8',
);
const vendoredOptionsSwift = readFileSync(
  join(__dirname, '..', '..', 'node_modules', 'expo-secure-store', 'ios', 'SecureStoreOptions.swift'),
  'utf8',
);
const sharedKeychainSwift = readFileSync(
  join(__dirname, '..', '..', 'targets', 'nse', 'SharedKeychain.swift'),
  'utf8',
);

/**
 * Read as text rather than imported. Importing the module would pull in the
 * real expo-secure-store, and with it the React Native runtime, which does not
 * parse in this plain-Node tier. A drift guard should not need a mock.
 */
const sharedKeychainTypeScript = readFileSync(
  join(__dirname, '..', '..', 'src', 'notifications', 'sharedKeychain.ts'),
  'utf8',
);

/**
 * Source with comment lines removed, so a prose mention cannot satisfy or trip
 * an assertion. Covers Swift `//` and TypeScript block comments, whose
 * continuation lines start with `*`.
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

function declaredSharedService(): string {
  const match = /SHARED_KEYCHAIN_SERVICE = '([^']+)'/.exec(sharedKeychainTypeScript);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[1];
}

describe('expo-secure-store Keychain query layout', () => {
  it('still defaults the service to "app" and mangles it with the auth suffix', () => {
    // The extension cannot know how a non-optional Bool decodes when absent
    // from the options object, so it tries every variant. If either half of
    // this changes, those variants stop matching.
    expect(vendoredModuleSwift).toContain('options.keychainService ?? "app"');
    expect(vendoredModuleSwift).toContain('service.append(":\\(requireAuthentication ? "auth" : "no-auth")")');
  });

  it('still keys the item on Data(key.utf8), not the key as a String', () => {
    // The single easiest detail to get wrong by guessing. A String here returns
    // errSecItemNotFound every time.
    expect(vendoredModuleSwift).toContain('let encodedKey = Data(key.utf8)');
    expect(vendoredModuleSwift).toContain('kSecAttrGeneric as String: encodedKey');
    expect(vendoredModuleSwift).toContain('kSecAttrAccount as String: encodedKey');
    expect(vendoredModuleSwift).toContain('kSecClass as String: kSecClassGenericPassword');
  });

  it('still applies accessGroup to kSecAttrAccessGroup', () => {
    // The whole mechanism the shared group depends on. Note it sits in the one
    // shared query builder, so it reaches get, set, update and delete alike.
    expect(vendoredModuleSwift).toContain('query[kSecAttrAccessGroup as String] = accessGroup');
    expect(vendoredOptionsSwift).toContain('var accessGroup: String?');
  });

  it('still exposes the accessGroup option under that exact name', () => {
    // Named `accessGroup`, NOT `keychainAccessGroup`. Renaming it would make
    // sharedPushStorageOptions() silently pass an ignored key.
    expect(vendoredOptionsSwift).toMatch(/@Field\s*\n?\s*var accessGroup: String\?/);
  });

  it('still reads no-auth first, then auth, then the bare legacy service', () => {
    const noAuthIndex = vendoredModuleSwift.indexOf('requireAuthentication: false');
    const authIndex = vendoredModuleSwift.indexOf('requireAuthentication: true');
    expect(noAuthIndex).toBeGreaterThan(-1);
    expect(authIndex).toBeGreaterThan(noAuthIndex);
  });
});

describe('SharedKeychain.swift mirrors that layout', () => {
  it('queries all three service variants in the same order', () => {
    expect(sharedKeychainSwift).toContain('["\\(service):no-auth", "\\(service):auth", service]');
  });

  it('uses the service name the app actually writes with', () => {
    // Not the "app" default: sharedKeychain.ts sets an explicit service so the
    // migration's delete of the legacy item is unambiguous.
    expect(sharedKeychainSwift).toContain(`static let service = "${declaredSharedService()}"`);
  });

  it('encodes the account and generic attributes as Data, matching the vendored builder', () => {
    expect(sharedKeychainSwift).toContain('let encodedKey = Data(key.utf8)');
    expect(sharedKeychainSwift).toContain('kSecAttrGeneric as String: encodedKey');
    expect(sharedKeychainSwift).toContain('kSecAttrAccount as String: encodedKey');
  });

  it('sets no access group on the read, relying on the entitlement to scope it', () => {
    // A read without kSecAttrAccessGroup searches every group the process is
    // entitled to, and the extension's entitlement lists only the shared one.
    // That keeps the team-prefixed literal out of Swift entirely.
    expect(withoutComments(sharedKeychainSwift)).not.toContain('kSecAttrAccessGroup');
  });

  it('reads the two item names the app writes', () => {
    expect(sharedKeychainSwift).toContain('"push.decrypt.key"');
    expect(sharedKeychainSwift).toContain('"push.identity.pk"');
  });
});

/**
 * The accessibility class is the finding this whole extension rests on, so it
 * is pinned against the VENDORED source and the real TypeScript rather than
 * against a mock.
 *
 * tests/unit/pushKeys.test.ts asserts the resolved options equal
 * 'afterFirstUnlockThisDeviceOnly', but that string comes from that file's own
 * expo-secure-store mock, so it mirrors the invariant instead of guarding it:
 * editing sharedKeychain.ts back to WHEN_UNLOCKED would just mean updating the
 * mock's expectation. These assertions are the ones that actually fail.
 */
describe('the NSE-facing items stay readable while the phone is locked', () => {
  it('expo-secure-store still maps the constant to the Keychain attribute we need', () => {
    // An NSE runs at delivery time, usually while the device is locked, and a
    // kSecAttrAccessibleWhenUnlocked item is unreadable exactly then. iOS never
    // re-renders a delivered notification, so under WHEN_UNLOCKED the decrypted
    // title would essentially never appear.
    expect(vendoredModuleSwift).toContain('case .afterFirstUnlockThisDeviceOnly:');
    expect(vendoredModuleSwift).toContain('return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(vendoredModuleSwift).toContain('Constant("AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY")');
  });

  it('sharedKeychain.ts uses AFTER_FIRST_UNLOCK for the shared items', () => {
    const code = withoutComments(sharedKeychainTypeScript);
    expect(code).toContain('keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
  });

  it('keeps WHEN_UNLOCKED for the no-group fallback only, and never relaxes THIS_DEVICE_ONLY', () => {
    const code = withoutComments(sharedKeychainTypeScript);

    // The fallback path (Android, and an unsigned local build) must be
    // bit-for-bit what it was before the extension existed.
    const fallbackIndex = code.indexOf('accessGroup === undefined');
    const whenUnlockedIndex = code.indexOf('WHEN_UNLOCKED_THIS_DEVICE_ONLY');
    const afterFirstUnlockIndex = code.indexOf('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
    expect(fallbackIndex).toBeGreaterThan(-1);
    expect(whenUnlockedIndex).toBeGreaterThan(fallbackIndex);
    expect(afterFirstUnlockIndex).toBeGreaterThan(whenUnlockedIndex);

    // THIS_DEVICE_ONLY is what keeps a restored backup from reconstituting a
    // working paired client (docs/security.md). Relaxing it would be a far
    // bigger change than the accessibility split, so no bare AFTER_FIRST_UNLOCK
    // or WHEN_UNLOCKED may appear.
    expect(code).not.toMatch(/AFTER_FIRST_UNLOCK(?!_THIS_DEVICE_ONLY)/);
    expect(code).not.toMatch(/WHEN_UNLOCKED(?!_THIS_DEVICE_ONLY)/);
  });
});
