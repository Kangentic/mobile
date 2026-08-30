---
paths:
  - "src/pairing/**"
  - "src/channel/**"
  - "src/notifications/**"
  - "src/state/**"
  # The NSE clause below governs code that lives here, so the rule has to load
  # when that code is edited. Without these two globs it never entered context
  # while the extension or its config plugin was being written.
  - "plugins/**"
  - "targets/**"
---
# Rule: long-lived secrets live in the platform secure store

The device identity key authorizes steering an agent that can edit code and run commands on the
paired desktop. AsyncStorage, MMKV, and a persisted Zustand store are all unencrypted at rest on
both platforms; losing that key to a stolen or backed-up device is a full compromise.

## The rule

- Long-lived secrets (the device identity X25519 key, per-pairing session keys, the
  push-decrypt key, the `ExponentPushToken`) live in `expo-secure-store`, which is backed by
  iOS Keychain and Android Keystore (StrongBox where available).
- Never store a key in AsyncStorage, MMKV, or a persisted (`persist()`) Zustand store.
- Session ephemerals (handshake state, in-flight nonces) stay in memory only.
- The Notification Service Extension reads its decrypt key via a shared Keychain access group,
  never a duplicate copy. Implemented in `src/notifications/sharedKeychain.ts`: the key MOVES
  into the shared group rather than being copied there, and the extension's entitlement lists
  only that group, so it cannot reach the identity secret key, the trust anchor, or settings.
  Its copy of the identity PUBLIC key (`push.identity.pk`) is not an exception to the
  no-duplicates clause: a public key is not a secret, and the extension needs it as the
  envelope's AAD but must never be handed the secret half to derive it.
- **`keychain-access-groups` order is load bearing.** Once that entitlement exists, an
  unqualified write lands in the FIRST entry rather than the implicit application-identifier
  group. The app-identifier group is listed first precisely so every existing unqualified write
  keeps its current home; reordering silently relocates the identity key, the trust anchor and
  the settings store, and the app reads as unpaired on next launch.
- **Accessibility is chosen per item, not globally.** Default to
  `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. The two items an extension reads use
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, because an extension runs while the phone is locked and
  a `WHEN_UNLOCKED` item is unreadable exactly then. Never relax `THIS_DEVICE_ONLY`: that is
  what keeps a restored backup from reconstituting a working paired client. Any change here
  changes what an attacker with a locked device can reach, so it also updates
  `docs/security.md`'s Key storage section.
- Document, rather than work around, the iOS Secure Enclave's P-256-only limitation: our X25519
  identity keys are Keychain-protected, not enclave-resident.

## Enforcement (self-maintaining)

- **Review (live now):** the `crypto-pairing-auditor` agent checks key-storage call sites during
  `/code-review`.
- **Test (live now, partial):** `tests/unit/pushKeys.test.ts` pins the shared-group placement,
  the accessibility split, and the migration's write-verify-then-delete ordering;
  `tests/unit/iosNotificationServiceExtension.test.ts` pins the entitlement order;
  `tests/unit/secureStoreKeychainLayout.test.ts` fails if an expo-secure-store upgrade changes
  the private Keychain query layout the extension mirrors. `ci.yml`'s `Native config (prebuild)`
  job asserts the generated app entitlements carry the shared group with the
  application-identifier group first.
- **Test (planned):** a scan forbidding `@react-native-async-storage/async-storage` imports and
  `persist(` on any key-holding store within the scoped directories.

## Scope

`src/pairing/**`, `src/channel/**`, `src/notifications/**`, `src/state/**`, plus `plugins/**`
and `targets/**` for the Notification Service Extension's share of the Keychain.
