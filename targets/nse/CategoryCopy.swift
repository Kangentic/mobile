import Foundation

/// The notification title per push category.
///
/// A deliberate duplicate of `titleForCategory` in
/// src/notifications/categoryCopy.ts: the extension is a separate process with
/// no access to the JS bundle, so the copy has to exist twice.
/// tests/unit/nseConstantsParity.test.ts reads this file and fails if the two
/// ever disagree, which is the only thing stopping the platforms drifting apart
/// one string at a time.
enum CategoryCopy {
  /// Returns nil for a category this build does not know. That matters: a
  /// newer desktop can send a category added after this app shipped, and
  /// leaving the placeholder untouched is better than inventing a title.
  static func title(forCategory category: String) -> String? {
    switch category {
    case "input-required":
      return "Agent needs your input"
    // The wire id stays 'turn-complete', but the signal means "a session went
    // quiet", not "a turn ended". Kept identical to the TypeScript side.
    case "turn-complete":
      return "Agent went idle"
    case "session-failed":
      return "Session stopped"
    case "plan-complete":
      return "Plan complete"
    case "spawn-stalled":
      return "Still preparing"
    // Every task of a workflow reached Done (protocol 0.21.0).
    case "workflow-complete":
      return "Workflow complete"
    default:
      return nil
    }
  }

  /// The title of an `input-required` wait whose kind the desktop reported
  /// (protocol 0.26.0). A deliberate duplicate of `titleForWaitKind`, pinned by
  /// the same parity test. Nil for a kind this build does not know, which keeps
  /// the category's title, as the protocol's parser drops such a kind.
  static func title(forWaitKind waitKind: String) -> String? {
    switch waitKind {
    case "question":
      return "Agent has a question"
    case "approval":
      return "Agent needs your approval"
    default:
      return nil
    }
  }

  /// Mirrors `decryptPushBlob`'s body composition so a notification reads the
  /// same on both platforms.
  static func body(taskTitle: String, detail: String) -> String {
    let resolvedTitle = taskTitle.isEmpty ? "Agent session" : taskTitle
    return detail.isEmpty ? resolvedTitle : "\(resolvedTitle) - \(detail)"
  }

  /// What an alert shows, in `decryptPushBlob`'s precedence: a Notify me row's
  /// own Title and Body when the envelope carries both (protocol 0.26.0), shown
  /// as written; else the wait kind's title on an `input-required` that names
  /// one, else the category's, over the composed body. Nil for a category this
  /// build does not know, which leaves the placeholder untouched.
  static func content(for envelope: PushEnvelopePlaintext) -> (title: String, body: String)? {
    guard let categoryTitle = title(forCategory: envelope.category) else { return nil }
    if let authoredTitle = envelope.title, let authoredBody = envelope.body {
      return (authoredTitle, authoredBody)
    }
    let waitTitle = envelope.category == "input-required" ? envelope.waitKind.flatMap { title(forWaitKind: $0) } : nil
    return (waitTitle ?? categoryTitle, body(taskTitle: envelope.taskTitle, detail: envelope.detail))
  }
}
