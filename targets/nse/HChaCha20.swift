import CryptoKit
import Foundation

/// XChaCha20-Poly1305, the AEAD `@kangentic/protocol` seals push envelopes with.
///
/// CryptoKit ships `ChaChaPoly`, which is the IETF construction with a 96-bit
/// nonce. XChaCha20 uses a 192-bit nonce and is defined
/// (draft-irtf-cfrg-xchacha) as exactly two steps on top of it:
///
///   1. subkey = HChaCha20(key, nonce[0..<16])
///   2. ChaCha20-Poly1305(subkey, 0x00000000 || nonce[16..<24])
///
/// So only HChaCha20 needs writing, and it is pure integer arithmetic. That is
/// why this target vendors no crypto dependency and needs no CocoaPods entry:
/// a Podfile entry would pull the extension into the generated Pods project and
/// into withIosPodsUuidCollisionGuard's blast radius for no gain.
///
/// Correctness is not taken on faith. tests/unit/nseCrypto.test.ts emits
/// fixtures with the protocol package's own `sealPushEnvelope`, and a macOS CI
/// job compiles this file with `swiftc` and checks it opens them byte for byte,
/// plus the published HChaCha20 test vector and the negative paths.
enum HChaCha20 {
  /// The four little-endian words of "expand 32-byte k".
  private static let constants: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]

  private static func rotateLeft(_ value: UInt32, _ count: UInt32) -> UInt32 {
    return (value << count) | (value >> (32 - count))
  }

  private static func littleEndianWord(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
    return UInt32(bytes[offset])
      | (UInt32(bytes[offset + 1]) << 8)
      | (UInt32(bytes[offset + 2]) << 16)
      | (UInt32(bytes[offset + 3]) << 24)
  }

  private static func quarterRound(_ state: inout [UInt32], _ a: Int, _ b: Int, _ c: Int, _ d: Int) {
    state[a] = state[a] &+ state[b]
    state[d] = rotateLeft(state[d] ^ state[a], 16)
    state[c] = state[c] &+ state[d]
    state[b] = rotateLeft(state[b] ^ state[c], 12)
    state[a] = state[a] &+ state[b]
    state[d] = rotateLeft(state[d] ^ state[a], 8)
    state[c] = state[c] &+ state[d]
    state[b] = rotateLeft(state[b] ^ state[c], 7)
  }

  /// 32-byte subkey from a 32-byte key and the first 16 bytes of the nonce.
  ///
  /// Note what this deliberately does NOT do: unlike the ChaCha20 block
  /// function it never adds the original state back in before serialising, and
  /// it emits words 0-3 and 12-15 rather than all sixteen. Both are what make
  /// it HChaCha20 rather than ChaCha20, and both are easy to "fix" into
  /// something that still produces plausible-looking bytes.
  static func subkey(key: [UInt8], nonceHead: [UInt8]) -> [UInt8]? {
    guard key.count == 32, nonceHead.count == 16 else { return nil }

    var state = [UInt32](repeating: 0, count: 16)
    for index in 0..<4 {
      state[index] = constants[index]
    }
    for index in 0..<8 {
      state[4 + index] = littleEndianWord(key, index * 4)
    }
    for index in 0..<4 {
      state[12 + index] = littleEndianWord(nonceHead, index * 4)
    }

    // 20 rounds, as ten column-then-diagonal double rounds.
    for _ in 0..<10 {
      quarterRound(&state, 0, 4, 8, 12)
      quarterRound(&state, 1, 5, 9, 13)
      quarterRound(&state, 2, 6, 10, 14)
      quarterRound(&state, 3, 7, 11, 15)
      quarterRound(&state, 0, 5, 10, 15)
      quarterRound(&state, 1, 6, 11, 12)
      quarterRound(&state, 2, 7, 8, 13)
      quarterRound(&state, 3, 4, 9, 14)
    }

    var subkeyBytes = [UInt8]()
    subkeyBytes.reserveCapacity(32)
    for index in [0, 1, 2, 3, 12, 13, 14, 15] {
      let word = state[index]
      subkeyBytes.append(UInt8(truncatingIfNeeded: word))
      subkeyBytes.append(UInt8(truncatingIfNeeded: word >> 8))
      subkeyBytes.append(UInt8(truncatingIfNeeded: word >> 16))
      subkeyBytes.append(UInt8(truncatingIfNeeded: word >> 24))
    }
    return subkeyBytes
  }
}

enum XChaCha20Poly1305 {
  static let keyLength = 32
  static let nonceLength = 24
  static let tagLength = 16

  /// Opens `nonce || ciphertext || tag` against the additional authenticated
  /// data. Returns nil on any failure, including a wrong key, a wrong AAD, and
  /// a tampered tag, so callers cannot accidentally distinguish them.
  static func open(key: [UInt8], nonce: [UInt8], ciphertextWithTag: [UInt8], additionalData: [UInt8]) -> [UInt8]? {
    guard key.count == keyLength, nonce.count == nonceLength, ciphertextWithTag.count >= tagLength else {
      return nil
    }
    guard let subkey = HChaCha20.subkey(key: key, nonceHead: Array(nonce[0..<16])) else { return nil }

    // The IETF nonce is four zero bytes followed by the last eight of the
    // XChaCha nonce, and CryptoKit's combined box is nonce || ciphertext || tag.
    var combined = [UInt8](repeating: 0, count: 4)
    combined.append(contentsOf: nonce[16..<24])
    combined.append(contentsOf: ciphertextWithTag)

    do {
      let sealedBox = try ChaChaPoly.SealedBox(combined: Data(combined))
      let opened = try ChaChaPoly.open(sealedBox, using: SymmetricKey(data: Data(subkey)), authenticating: Data(additionalData))
      return [UInt8](opened)
    } catch {
      // Swallowed without logging: the error can echo attacker-controlled
      // bytes, and decrypted content must never leak
      // (.claude/rules/e2e-notification-privacy.md).
      return nil
    }
  }
}
