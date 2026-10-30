import Foundation

/// The sealed push payload, mirroring `PushEnvelopePlaintext` in
/// `@kangentic/protocol`. Every `let` field is required; a missing or
/// wrong-typed one means the blob is not something this build understands, and
/// the caller shows the placeholder. The optional ones are dropped instead when
/// malformed or unknown, as the protocol's parser drops them, so the alert
/// still opens.
struct PushEnvelopePlaintext {
  let category: String
  let projectId: String
  let taskId: String
  let sessionId: String
  let taskTitle: String
  let detail: String
  /// Wall-clock milliseconds, as sealed by the desktop.
  let sentAt: Double
  /// Older alerts this push resolves (protocol 0.23.0), removed before it is
  /// presented. Parsed tolerantly (NotificationPruning.parseClearEntries): a
  /// malformed list is empty, never a reason to lose the notification.
  let clears: [PushClearEntry]
  /// What an `input-required` wait is for (protocol 0.26.0): "question" or
  /// "approval". Nil when absent or a kind this build does not know.
  var waitKind: String? = nil
  /// A Notify me automation row's own Title and Body (protocol 0.26.0), set
  /// together. Each is nil when absent or not a string.
  var title: String? = nil
  var body: String? = nil
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

    // Read OUTSIDE the guard above: a malformed optional field costs only that
    // field, never the alert. A wait kind this build does not know reads as no
    // kind, so the category's title stays.
    let waitKind = (fields["waitKind"] as? String).flatMap { CategoryCopy.title(forWaitKind: $0) != nil ? $0 : nil }

    return PushEnvelopePlaintext(
      category: category,
      projectId: projectId,
      taskId: taskId,
      sessionId: sessionId,
      taskTitle: taskTitle,
      detail: detail,
      sentAt: sentAt,
      clears: NotificationPruning.parseClearEntries(fields["clears"]),
      waitKind: waitKind,
      title: fields["title"] as? String,
      body: fields["body"] as? String
    )
  }
}
