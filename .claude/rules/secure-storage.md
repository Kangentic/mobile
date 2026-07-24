---
paths:
  - "src/pairing/**"
  - "src/channel/**"
  - "src/notifications/**"
  - "src/state/**"
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
  never a duplicate copy.
- Document, rather than work around, the iOS Secure Enclave's P-256-only limitation: our X25519
  identity keys are Keychain-protected, not enclave-resident.

## Enforcement (self-maintaining)

- **Review (live now):** the `crypto-pairing-auditor` agent checks key-storage call sites during
  `/code-review`.
- **Test (planned):** a scan forbidding `@react-native-async-storage/async-storage` imports and
  `persist(` on any key-holding store within the scoped directories.

## Scope

`src/pairing/**`, `src/channel/**`, `src/notifications/**`, `src/state/**`.
