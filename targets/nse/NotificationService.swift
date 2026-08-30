import Foundation
import UserNotifications

/// Decrypts a Kangentic push envelope on-device, before iOS renders the alert.
///
/// The OS-visible payload is ciphertext plus a generic per-category placeholder
/// (.claude/rules/e2e-notification-privacy.md). The desktop sets
/// `mutable-content: 1` and keeps a title and body on every iOS push
/// specifically so this extension gets invoked and has something to replace.
/// APNs will not run a service extension for a push with no alert, so making
/// iOS data-only to match Android would silently disable all of this.
///
/// FOUR CONTRACTS, EACH OF WHICH FAILS SILENTLY IF BROKEN:
///
///   1. `contentHandler` is called exactly once on every path, including the
///      expiry path. Calling it twice is undefined behaviour; calling it zero
///      times shows nothing at all.
///   2. Only `title` and `body` are assigned, on a mutable COPY of the original
///      content. Building a fresh `UNMutableNotificationContent` would drop
///      `userInfo`, and src/notifications/tapRouter.ts decrypts the blob out of
///      `userInfo` on tap to route. The notification would still look right and
///      simply stop navigating anywhere.
///   3. `userInfo` is never written to. In particular the decrypted `taskId` is
///      NOT added to it: the tap router already re-derives it, and storing task
///      identity in the OS-visible object is what the privacy rule forbids.
///   4. Nothing is ever logged, not even on failure. Error text can echo
///      attacker-controlled bytes, and decrypted content must never leak. This
///      matches src/notifications/pushDecrypt.ts, which swallows for the same
///      reason. No Sentry here either (.claude/rules/crash-reporting-scope.md).
///
/// Every failure mode - no blob, no key, no identity, wrong key, wrong
/// recipient AAD, tampered blob, stale sentAt, unknown category, running out of
/// time - leaves the placeholder exactly as delivered.
final class NotificationService: UNNotificationServiceExtension {
  private static let x25519PublicKeyLength = 32

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var pendingContent: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    // Held so the expiry path can still deliver the untouched placeholder.
    self.pendingContent = request.content

    guard let mutableContent = request.content.mutableCopy() as? UNMutableNotificationContent else {
      deliver()
      return
    }
    self.pendingContent = mutableContent

    if let decrypted = Self.decrypt(userInfo: request.content.userInfo),
      let title = CategoryCopy.title(forCategory: decrypted.category) {
      mutableContent.title = title
      mutableContent.body = CategoryCopy.body(taskTitle: decrypted.taskTitle, detail: decrypted.detail)
    }

    deliver()
  }

  /// iOS is about to stop giving this extension time. Deliver whatever is in
  /// hand rather than losing the notification entirely.
  override func serviceExtensionTimeWillExpire() {
    deliver()
  }

  /// Contract 1. Clearing the handler before invoking it is what makes a
  /// didReceive/expire race deliver once rather than twice.
  private func deliver() {
    guard let handler = contentHandler, let content = pendingContent else { return }
    contentHandler = nil
    handler(content)
  }

  private static func decrypt(userInfo: [AnyHashable: Any]) -> PushEnvelopePlaintext? {
    guard let blob = extractBlob(from: userInfo) else { return nil }
    guard
      let pushKey = SharedKeychain.bytes(
        forKey: SharedKeychain.pushDecryptKeyName,
        expectedLength: XChaCha20Poly1305.keyLength
      ),
      let identityPublicKey = SharedKeychain.bytes(
        forKey: SharedKeychain.identityPublicKeyName,
        expectedLength: x25519PublicKeyLength
      )
    else { return nil }

    return PushEnvelope.open(blob: blob, pushKey: pushKey, recipientStaticPublicKey: identityPublicKey)
  }

  /// Mirrors `extractBlobFromTaskData` in src/notifications/pushDecrypt.ts.
  ///
  /// The Expo push service does not put the message's `data` object at the top
  /// level of the APNs payload: it nests it under `body`, which arrives either
  /// as a dictionary or as a JSON string depending on the delivery path. Reading
  /// only `userInfo["blob"]` would work in a hand-crafted test push and never in
  /// production.
  static func extractBlob(from userInfo: [AnyHashable: Any]) -> String? {
    if let blob = userInfo["blob"] as? String { return blob }

    for key in ["dataString", "body"] {
      if let nested = userInfo[key] as? [AnyHashable: Any], let blob = nested["blob"] as? String {
        return blob
      }
      if let nestedJson = userInfo[key] as? String, let blob = blobFromJsonString(nestedJson) {
        return blob
      }
    }
    return nil
  }

  private static func blobFromJsonString(_ json: String) -> String? {
    guard
      let data = json.data(using: .utf8),
      let parsed = try? JSONSerialization.jsonObject(with: data),
      let fields = parsed as? [String: Any],
      let blob = fields["blob"] as? String
    else { return nil }
    return blob
  }
}
