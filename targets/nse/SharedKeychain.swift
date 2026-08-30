import Foundation
import Security

/// Reads the two items the app stores for this extension out of the shared
/// Keychain access group.
///
/// THIS MIRRORS expo-secure-store's PRIVATE QUERY LAYOUT, which is a coupling
/// worth naming rather than hiding. The app writes these items through
/// `SecureStore.setItemAsync`, so the extension has to reproduce the exact
/// query that module builds (`SecureStoreModule.swift`, `query(with:options:)`)
/// or `SecItemCopyMatching` returns `errSecItemNotFound` and every notification
/// silently falls back to the placeholder. Two details are easy to get wrong by
/// guessing, and both were read out of the vendored source rather than assumed:
///
///   - `kSecAttrAccount` and `kSecAttrGeneric` hold `Data(key.utf8)`, NOT the
///     key as a String.
///   - the service name is mangled. expo-secure-store appends `:no-auth` or
///     `:auth` depending on `requireAuthentication`, and its own reader tries
///     no-auth, then auth, then the bare legacy service. This mirrors all three
///     rather than depending on how a non-optional Bool decodes when absent
///     from the options object.
///
/// tests/unit/secureStoreKeychainLayout.test.ts reads the vendored Swift and
/// fails if any of that drifts, because an SDK bump that changed it would
/// otherwise degrade this extension permanently with every gate green.
///
/// No `kSecAttrAccessGroup` is set on the query. A read without one searches
/// every group the process is entitled to, and this extension's entitlement
/// lists only the shared group, so the effect is the same without needing the
/// team-prefixed literal in Swift.
enum SharedKeychain {
  /// Must equal SHARED_KEYCHAIN_SERVICE in src/notifications/sharedKeychain.ts.
  static let service = "kangentic.push"

  static let pushDecryptKeyName = "push.decrypt.key"
  static let identityPublicKeyName = "push.identity.pk"

  private static var serviceVariants: [String] {
    return ["\(service):no-auth", "\(service):auth", service]
  }

  private static func read(service: String, key: String) -> String? {
    let encodedKey = Data(key.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrGeneric as String: encodedKey,
      kSecAttrAccount as String: encodedKey,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: kCFBooleanTrue as Any,
    ]

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func string(forKey key: String) -> String? {
    for candidate in serviceVariants {
      if let value = read(service: candidate, key: key) { return value }
    }
    return nil
  }

  /// Lowercase hex, as written by `bytesToHex`. Returns nil unless the decoded
  /// value is exactly `expectedLength` bytes, so a truncated or corrupted item
  /// degrades to the placeholder rather than being fed to the AEAD.
  static func bytes(forKey key: String, expectedLength: Int) -> [UInt8]? {
    guard let hex = string(forKey: key), hex.count == expectedLength * 2 else { return nil }

    var bytes = [UInt8]()
    bytes.reserveCapacity(expectedLength)
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    return bytes
  }
}
