import * as SecureStore from 'expo-secure-store';

/**
 * Where the two items the iOS Notification Service Extension reads actually
 * live in the Keychain.
 *
 * The NSE is a separate process from the app, so it cannot see the app's own
 * Keychain items. It reads them through a shared access group
 * (secure-storage.md: "via a shared Keychain access group, never a duplicate
 * copy"), which needs three things to line up: a `keychain-access-groups`
 * entitlement on both bundles (injected by
 * plugins/withIosNotificationServiceExtension.ts), the resolved group string at
 * runtime (below), and the item written with that group rather than the app's
 * default one.
 *
 * NO react-native OR expo-constants IMPORT HERE, DELIBERATELY. pushKeys.ts and
 * pushDecrypt.ts form the on-device decrypt path, which is unit-tested in a
 * plain Node environment; pushDecrypt.ts's own header records that categoryCopy
 * was split out of channels.ts for exactly this reason. Reaching for
 * `Platform.OS` or `Constants.expoConfig` here would drag the React Native
 * runtime into every test that transitively imports the push key store. An
 * `EXPO_PUBLIC_` variable is inlined by Metro at bundle time and reads as a
 * plain string in Node, so it costs nothing.
 *
 * TWO DELIBERATE DEPARTURES FROM THE OTHER SECURE-STORE CALL SITES:
 *
 * 1. `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, not `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
 *    An NSE runs at delivery time, which is usually while the phone is LOCKED,
 *    and a `WHEN_UNLOCKED` item is unreadable in exactly that state. iOS never
 *    re-renders an already-delivered notification, so under `WHEN_UNLOCKED` the
 *    decrypted title would essentially never appear. `THIS_DEVICE_ONLY` is
 *    retained, so the "restoring a backup onto new hardware cannot reconstitute
 *    a working paired client" property in docs/security.md still holds. The
 *    identity SECRET key (src/pairing/deviceIdentity.ts) and the trust anchor
 *    deliberately stay `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: nothing outside the app
 *    reads them.
 *
 * 2. An explicit `keychainService`. This is NOT cosmetic. expo-secure-store's
 *    `deleteValueWithKeyAsync` deletes every service variant for the options it
 *    is handed, so the differing service name is the only thing that makes the
 *    migration's delete-the-old-item step unambiguous. Were the service left at
 *    the default, the legacy item and the migrated one would differ only by
 *    access group, and a group-less delete could match the migrated one.
 */

/** Only ever read by the NSE; the app reads the live identity from pushIdentity.ts. */
export const PUSH_IDENTITY_PUBLIC_KEY_STORAGE_KEY = 'push.identity.pk';

/**
 * Deliberately not the `"app"` default: see departure 2 above. expo-secure-store
 * mangles this into `"<service>:no-auth"` / `"<service>:auth"` internally, which
 * targets/nse/SharedKeychain.swift mirrors.
 */
export const SHARED_KEYCHAIN_SERVICE = 'kangentic.push';

/**
 * The options every pre-NSE write used: the default keychainService and no
 * access group. Reproduces the legacy query exactly, which is what the
 * migration's read and delete need. `keychainAccessible` is omitted because it
 * is a write-time attribute and plays no part in matching an existing item.
 */
export const LEGACY_PUSH_STORAGE_OPTIONS: SecureStore.SecureStoreOptions = {};

/**
 * The resolved access group (`<TeamID>.com.kangentic.mobile.shared`).
 *
 * `kSecAttrAccessGroup` needs the team-prefixed literal, but nothing about the
 * Apple team may be committed (no-personal-info.md; the whole signing pipeline
 * derives it from the provisioning profile on the runner instead). So
 * .github/workflows/build-ios.yml composes this from the same profile-derived
 * team id it already exports for withIosManualSigning, and Metro inlines it.
 * This leaks nothing a shipped IPA does not already expose through its embedded
 * profile and `application-identifier`.
 *
 * Read as one static member expression because that is the form Metro's
 * inlining recognises. Destructuring or indexing `process.env` would survive
 * Node and silently resolve to undefined on device.
 */
export function resolveSharedAccessGroup(): string | undefined {
  const accessGroup = process.env.EXPO_PUBLIC_KANGENTIC_IOS_KEYCHAIN_GROUP;
  return typeof accessGroup === 'string' && accessGroup.length > 0 ? accessGroup : undefined;
}

/**
 * Whether this build has an NSE to share with.
 *
 * Keyed off the access group rather than `Platform.OS` both to keep the React
 * Native import out (see the header) and because the group is the thing that
 * actually has to exist: without it there is nowhere shared to write, so the
 * migration and the second Keychain item would be pure churn. Only
 * build-ios.yml sets the variable, so an Android build never takes this path.
 */
export function usesSharedKeychain(): boolean {
  return resolveSharedAccessGroup() !== undefined;
}

/**
 * Where the push key and the NSE's copy of the identity public key are written
 * from now on. Falls back to the pre-NSE options when no group is configured,
 * so an Android build and an unsigned local build are bit-for-bit what they
 * were.
 */
export function sharedPushStorageOptions(): SecureStore.SecureStoreOptions {
  const accessGroup = resolveSharedAccessGroup();
  if (accessGroup === undefined) {
    return { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  }
  return {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    keychainService: SHARED_KEYCHAIN_SERVICE,
    accessGroup,
  };
}
