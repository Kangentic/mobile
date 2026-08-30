import Foundation

/// The sealed push payload, mirroring `PushEnvelopePlaintext` in
/// `@kangentic/protocol`. Every field is required; a missing or wrong-typed one
/// means the blob is not something this build understands, and the caller shows
/// the placeholder.
struct PushEnvelopePlaintext {
  let category: String
  let projectId: String
  let taskId: String
  let sessionId: String
  let taskTitle: String
  let detail: String
  /// Wall-clock milliseconds, as sealed by the desktop.
  let sentAt: Double
}

/// Opens the envelope the desktop seals, byte-compatible with
/// `openPushEnvelope` in `@kangentic/protocol`:
///
///   base64url_unpadded( nonce[24] || XChaCha20-Poly1305(pushKey, nonce, aad, JSON) )
///
/// where the AAD is this phone's 32-byte static X25519 public key. Note the
/// freshness window is checked AFTER decryption, because `sentAt` lives inside
/// the sealed JSON rather than in the OS-visible payload. There is no top-level
/// `sentAt` to read, and an implementation that looked for one would silently
/// stop enforcing the window.
enum PushEnvelope {
  /// Mirrored from the protocol package rather than imported, so
  /// tests/unit/nseConstantsParity.test.ts pins them against their source.
  static let maximumAgeMilliseconds: Double = 24 * 60 * 60 * 1000
  static let maximumFutureSkewMilliseconds: Double = 5 * 60 * 1000

  /// RFC 4648 section 5, unpadded. Foundation only decodes the standard
  /// alphabet with padding, so translate before handing it over.
  static func decodeBase64Url(_ encoded: String) -> [UInt8]? {
    var standard = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let remainder = standard.count % 4
    if remainder == 2 {
      standard.append("==")
    } else if remainder == 3 {
      standard.append("=")
    } else if remainder != 0 {
      return nil
    }
    guard let data = Data(base64Encoded: standard) else { return nil }
    return [UInt8](data)
  }

  static func open(blob: String, pushKey: [UInt8], recipientStaticPublicKey: [UInt8], now: Date = Date()) -> PushEnvelopePlaintext? {
    guard let bytes = decodeBase64Url(blob) else { return nil }
    guard bytes.count >= XChaCha20Poly1305.nonceLength + XChaCha20Poly1305.tagLength else { return nil }

    let nonce = Array(bytes[0..<XChaCha20Poly1305.nonceLength])
    let ciphertextWithTag = Array(bytes[XChaCha20Poly1305.nonceLength...])
    guard
      let plaintextBytes = XChaCha20Poly1305.open(
        key: pushKey,
        nonce: nonce,
        ciphertextWithTag: ciphertextWithTag,
        additionalData: recipientStaticPublicKey
      )
    else { return nil }

    guard let parsed = parse(plaintextBytes) else { return nil }

    let nowMilliseconds = now.timeIntervalSince1970 * 1000
    if parsed.sentAt < nowMilliseconds - maximumAgeMilliseconds { return nil }
    if parsed.sentAt > nowMilliseconds + maximumFutureSkewMilliseconds { return nil }
    return parsed
  }

  private static func parse(_ plaintextBytes: [UInt8]) -> PushEnvelopePlaintext? {
    guard
      let json = try? JSONSerialization.jsonObject(with: Data(plaintextBytes)),
      let fields = json as? [String: Any],
      let category = fields["category"] as? String,
      let projectId = fields["projectId"] as? String,
      let taskId = fields["taskId"] as? String,
      let sessionId = fields["sessionId"] as? String,
      let taskTitle = fields["taskTitle"] as? String,
      let detail = fields["detail"] as? String,
      let sentAt = fields["sentAt"] as? Double,
      sentAt.isFinite
    else { return nil }

    return PushEnvelopePlaintext(
      category: category,
      projectId: projectId,
      taskId: taskId,
      sessionId: sessionId,
      taskTitle: taskTitle,
      detail: detail,
      sentAt: sentAt
    )
  }
}
