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
}
