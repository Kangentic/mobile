import Foundation
import UserNotifications

/// Decrypts a Kangentic push envelope on-device, before iOS renders the alert.
///
/// The OS-visible payload is ciphertext plus a generic per-category placeholder
/// (.claude/rules/e2e-notification-privacy.md). The desktop sets
/// `mutable-content: 1` and keeps a title and body on every iOS push
/// specifically so this extension gets invoked and has something to replace.
/// APNs will not run a service extension for a push with no alert, so making
/// iOS data-only to match Android would silently disable all of this. (The
/// desktop's STANDALONE sealed clears are exactly such pushes, which is why the
/// app's background task handles those and this file only ever sees the
/// `clears` a visible push carries.)
///
/// FOUR CONTRACTS, EACH OF WHICH FAILS SILENTLY IF BROKEN:
///
///   1. `contentHandler` is called exactly once on every path, including the
///      expiry path. Calling it twice is undefined behaviour; calling it zero
///      times shows nothing at all. Pruning makes delivery asynchronous, so the
///      handler is taken under `deliveryLock`: a delivered-notifications
///      completion and `serviceExtensionTimeWillExpire` run on different threads.
///   2. Only `title`, `body` and `threadIdentifier` are assigned, on a mutable
///      COPY of the original content. Building a fresh
///      `UNMutableNotificationContent` would drop `userInfo`, and
///      src/notifications/tapRouter.ts decrypts the blob out of `userInfo` on tap
///      to route. The notification would still look right and simply stop
///      navigating anywhere. The thread identifier is an opaque keyed hash
///      (NotificationPruning.threadIdentifier), never a task id.
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
/// time - leaves the placeholder exactly as delivered. A failure while PRUNING
/// costs only the pruning: the alert still goes out, rich if it decrypted.
final class NotificationService: UNNotificationServiceExtension {
  private static let x25519PublicKeyLength = 32
  /// How long pruning waits for iOS to confirm a removal before delivering
  /// anyway, and how often it looks. Far inside the ~30 s extension budget.
  private static let removalConfirmationTimeout: TimeInterval = 1.5
  private static let removalConfirmationInterval: TimeInterval = 0.1

  private struct PushKeys {
    let pushKey: [UInt8]
    let identityPublicKey: [UInt8]
  }

  private let deliveryLock = NSLock()
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var pendingContent: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    // Held so the expiry path can still deliver the untouched placeholder.
    hold(handler: contentHandler, content: request.content)

    guard let mutableContent = request.content.mutableCopy() as? UNMutableNotificationContent else {
      deliver()
      return
    }

    guard
      let keys = Self.readKeys(),
      let blob = Self.extractBlob(from: request.content.userInfo),
      let decrypted = PushEnvelope.open(blob: blob, pushKey: keys.pushKey, recipientStaticPublicKey: keys.identityPublicKey)
    else {
      hold(content: mutableContent)
      deliver()
      return
    }

    if let content = CategoryCopy.content(for: decrypted) {
      mutableContent.title = content.title
      mutableContent.body = content.body
      if let threadIdentifier = NotificationPruning.threadIdentifier(for: decrypted, pushKey: keys.pushKey) {
        mutableContent.threadIdentifier = threadIdentifier
      }
    }
    // Held BEFORE pruning starts, so the expiry path delivers the rich alert.
    hold(content: mutableContent)

    // Strong on purpose: nothing stores this closure, so there is no cycle, and
    // a weak capture would turn a released instance into an alert never shown.
    pruneDelivered(for: decrypted, keys: keys) {
      self.deliver()
    }
  }

  /// iOS is about to stop giving this extension time. Deliver whatever is in
  /// hand rather than losing the notification entirely.
  override func serviceExtensionTimeWillExpire() {
    deliver()
  }

  private func hold(handler: ((UNNotificationContent) -> Void)? = nil, content: UNNotificationContent) {
    deliveryLock.lock()
    if let handler { contentHandler = handler }
    pendingContent = content
    deliveryLock.unlock()
  }

  /// Contract 1. Taking the handler under the lock, and clearing it before
  /// invoking it, is what makes a prune/expire race deliver once rather than
  /// twice.
  private func deliver() {
    deliveryLock.lock()
    guard let handler = contentHandler, let content = pendingContent else {
      deliveryLock.unlock()
      return
    }
    contentHandler = nil
    deliveryLock.unlock()
    handler(content)
  }

  /// PRUNING, UNPROVEN ON HARDWARE UNTIL A TESTFLIGHT RUN SAYS OTHERWISE. Removes
  /// the delivered alerts this push resolves (its piggybacked `clears`) or
  /// replaces (an older alert under the same identity), so iOS keeps one alert
  /// per session and category the way Android's stable ids do. Apple documents
  /// neither that removal works from an extension nor when it completes, so the
  /// removal is confirmed by re-reading, for at most
  /// `removalConfirmationTimeout`, and the alert is delivered either way.
  ///
  /// Self-contained on purpose: if hardware shows removal does not work from an
  /// extension, delete this function and call `deliver()` in its place.
  private func pruneDelivered(for incoming: PushEnvelopePlaintext, keys: PushKeys, then finish: @escaping () -> Void) {
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      var opened = [(identifier: String, envelope: PushEnvelopePlaintext)]()
      for notification in delivered {
        guard
          let blob = Self.extractBlob(from: notification.request.content.userInfo),
          let envelope = PushEnvelope.open(blob: blob, pushKey: keys.pushKey, recipientStaticPublicKey: keys.identityPublicKey)
        else { continue }
        opened.append((identifier: notification.request.identifier, envelope: envelope))
      }
      let identifiers = NotificationPruning.identifiersToRemove(incoming: incoming, delivered: opened)
      guard !identifiers.isEmpty else {
        finish()
        return
      }
      center.removeDeliveredNotifications(withIdentifiers: identifiers)
      Self.awaitRemoval(
        of: Set(identifiers),
        center: center,
        deadline: Date().addingTimeInterval(Self.removalConfirmationTimeout),
        then: finish
      )
    }
  }

  /// `removeDeliveredNotifications` has no completion handler, and a removal
  /// still in flight when the new alert is delivered is the reported way it
  /// fails. So: re-read until the identifiers are gone or the deadline passes.
  private static func awaitRemoval(
    of identifiers: Set<String>,
    center: UNUserNotificationCenter,
    deadline: Date,
    then finish: @escaping () -> Void
  ) {
    center.getDeliveredNotifications { delivered in
      let stillDelivered = delivered.contains { identifiers.contains($0.request.identifier) }
      if !stillDelivered || Date() >= deadline {
        finish()
        return
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + Self.removalConfirmationInterval) {
        Self.awaitRemoval(of: identifiers, center: center, deadline: deadline, then: finish)
      }
    }
  }

  /// Both items the extension reads, read once per push: the incoming alert and
  /// every delivered one it is compared against open under the same pair.
  private static func readKeys() -> PushKeys? {
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
    return PushKeys(pushKey: pushKey, identityPublicKey: identityPublicKey)
  }

  /// Mirrors `extractBlobFromTaskData` in src/notifications/pushDecrypt.ts, as
  /// a deliberate SUPERSET rather than a line-for-line copy.
  ///
  /// The Expo push service does not put the message's `data` object at the top
  /// level of the APNs payload: it nests it under `body`, which arrives either
  /// as a dictionary or as a JSON string depending on the delivery path. Reading
  /// only `userInfo["blob"]` would work in a hand-crafted test push and never in
  /// production.
  ///
  /// The nested-DICTIONARY branch is the half `extractBlobFromTaskData` does not
  /// have, and that is correct rather than drift: this reads the raw APNs
  /// `userInfo`, while every JS caller of that function gets an already-unwrapped
  /// `data` (expo-notifications assigns `userInfo["body"] as? [String: Any]` for
  /// a presented or tapped notification). The one JS path that does see the raw
  /// dictionary is the iOS background task (BackgroundEventTransformer.swift
  /// passes `userInfo` minus `aps` through), and it only ever looks for a sealed
  /// CLEAR there, through `findClearField`, which has this branch too. Do not
  /// "reconcile" the two by deleting this branch.
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
