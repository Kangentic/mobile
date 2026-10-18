import CryptoKit
import Foundation

/// One entry of a sealed clear, mirroring `PushClearEntry` in
/// `@kangentic/protocol` (0.23.0): a notification the desktop saw resolve, named
/// by the category and ids copied verbatim from the envelope that announced it.
/// `notifiedAt` is the `sentAt` of the newest notification the entry clears.
///
/// `sessionKind` is deliberately not read. The ids alone are unique, and the
/// app's own matcher (`clearEntryCovers` in src/notifications/notificationRouting.ts)
/// leaves it out for the same reason, so the two platforms apply one rule.
struct PushClearEntry: Equatable {
  let category: String
  let projectId: String
  let taskId: String
  let sessionId: String
  let notifiedAt: Double
}

/// The pure half of the extension's notification pruning: which delivered alerts
/// an incoming push removes, and the opaque thread it groups under. Kept apart
/// from NotificationService.swift, which needs UserNotifications, so the
/// "NSE crypto (swiftc)" job can compile and check it on a macOS runner against
/// cases the protocol package generated (tests/swift/pushEnvelopeFixtures.json).
///
/// Like the rest of the extension it logs nothing, on any path.
enum NotificationPruning {
  /// Tolerant, like `parsePushClearEntries` in the protocol package: a non-array
  /// yields nothing, and an entry that is not an object, names a category this
  /// build does not know, has a non-string id, or a non-numeric or non-finite
  /// `notifiedAt` is dropped on its own. A bad entry never costs the others, or
  /// the notification they ride on.
  ///
  /// The known categories are CategoryCopy's, not a second list: a category the
  /// extension has a title for is exactly one it can parse, and
  /// tests/unit/nseConstantsParity.test.ts pins that switch to PUSH_CATEGORIES.
  static func parseClearEntries(_ value: Any?) -> [PushClearEntry] {
    guard let candidates = value as? [Any] else { return [] }
    var entries = [PushClearEntry]()
    for candidate in candidates {
      guard
        let fields = candidate as? [String: Any],
        let category = fields["category"] as? String,
        CategoryCopy.title(forCategory: category) != nil,
        let projectId = fields["projectId"] as? String,
        let taskId = fields["taskId"] as? String,
        let sessionId = fields["sessionId"] as? String,
        let notifiedAt = jsonNumber(fields["notifiedAt"])
      else { continue }
      entries.append(
        PushClearEntry(category: category, projectId: projectId, taskId: taskId, sessionId: sessionId, notifiedAt: notifiedAt)
      )
    }
    return entries
  }

  /// A finite JSON number, and only a number. JSONSerialization hands back
  /// `true` as an NSNumber that bridges to 1.0, which the protocol's
  /// `typeof === 'number'` check would reject, so a boolean is refused here too.
  private static func jsonNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    return double.isFinite ? double : nil
  }

  /// Whether a clear entry removes a delivered alert: the same category and all
  /// three ids, and the alert's own `sentAt` at or before the entry's
  /// `notifiedAt`. The bound is what keeps a clear that arrives late from
  /// removing a newer alert for the same session and category.
  static func clearCovers(_ entry: PushClearEntry, delivered: PushEnvelopePlaintext) -> Bool {
    return entry.category == delivered.category
      && entry.projectId == delivered.projectId
      && entry.taskId == delivered.taskId
      && entry.sessionId == delivered.sessionId
      && delivered.sentAt <= entry.notifiedAt
  }

  /// The identity an alert is replaced under, character for character the
  /// Android stable id (`notificationIdForRouting` in
  /// src/notifications/notificationRouting.ts): the category plus the narrowest
  /// thing the alert names, its session, else its task, else its project. Nil for
  /// a category this build does not know, or an alert that names nothing.
  ///
  /// Session first rather than task, so a second session's alert never removes a
  /// first session's that is still owed, and workflow-complete alerts (empty
  /// task and session) from different projects never collide.
  static func identityKey(_ envelope: PushEnvelopePlaintext) -> String? {
    guard CategoryCopy.title(forCategory: envelope.category) != nil else { return nil }
    if !envelope.sessionId.isEmpty { return "kangentic:\(envelope.category):session:\(envelope.sessionId)" }
    if !envelope.taskId.isEmpty { return "kangentic:\(envelope.category):task:\(envelope.taskId)" }
    if !envelope.projectId.isEmpty { return "kangentic:\(envelope.category):project:\(envelope.projectId)" }
    return nil
  }

  /// Whether the incoming push replaces a delivered one, the way a repeat
  /// replaces an alert under its stable id on Android: the same identity, and
  /// the delivered one sealed at or before the incoming one. An older push that
  /// arrives late therefore never removes the newer alert already on screen.
  static func supersedes(_ incoming: PushEnvelopePlaintext, delivered: PushEnvelopePlaintext) -> Bool {
    guard let incomingKey = identityKey(incoming), incomingKey == identityKey(delivered) else { return false }
    return delivered.sentAt <= incoming.sentAt
  }

  /// The request identifiers of every delivered alert the incoming push removes:
  /// those its piggybacked clears cover, and those it supersedes.
  static func identifiersToRemove(
    incoming: PushEnvelopePlaintext,
    delivered: [(identifier: String, envelope: PushEnvelopePlaintext)]
  ) -> [String] {
    return delivered.compactMap { candidate in
      let cleared = incoming.clears.contains { clearCovers($0, delivered: candidate.envelope) }
      return cleared || supersedes(incoming, delivered: candidate.envelope) ? candidate.identifier : nil
    }
  }

  /// HKDF info label for the thread key: a key of its own for the job, never the
  /// push key itself, which is the AEAD key (docs/security.md, one key per job).
  static let threadKeyInfo = "kangentic nse thread v1"

  /// The opaque `threadIdentifier` that stacks a task's alerts: HMAC-SHA256 under
  /// a key derived from the push key, over `task:<taskId>`, else
  /// `project:<projectId>` for an alert that names no task (workflow-complete),
  /// truncated to 16 bytes, lowercase hex. Never the task id itself: the
  /// identifier lives on the OS-visible notification, and this way it is stable
  /// per task on this device and meaningless to anyone without the push key.
  /// Nil when the alert names neither.
  static func threadIdentifier(for envelope: PushEnvelopePlaintext, pushKey: [UInt8]) -> String? {
    let subject: String
    if !envelope.taskId.isEmpty {
      subject = "task:\(envelope.taskId)"
    } else if !envelope.projectId.isEmpty {
      subject = "project:\(envelope.projectId)"
    } else {
      return nil
    }
    let threadKey = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: Data(pushKey)),
      info: Data(threadKeyInfo.utf8),
      outputByteCount: 32
    )
    let code = HMAC<SHA256>.authenticationCode(for: Data(subject.utf8), using: threadKey)
    return Array(code).prefix(16).map { String(format: "%02x", $0) }.joined()
  }
}
