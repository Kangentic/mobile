import Foundation

// Cross-language check on the Notification Service Extension's crypto.
//
// The extension re-implements XChaCha20-Poly1305 in Swift because CryptoKit
// ships only the 96-bit-nonce IETF variant. Nothing about that is exercised by
// any other gate in this repo: there is no iOS test tier, the simulator job
// only proves the target COMPILES, and a wrong subkey derivation produces a
// clean decrypt failure rather than a crash. The visible symptom would be every
// iPhone notification quietly showing the placeholder.
//
// So this harness opens envelopes sealed by the protocol package's own
// `sealPushEnvelope` (tests/swift/pushEnvelopeFixtures.json, regenerated with
// scripts/generateNseCryptoFixtures.mjs) and checks the negative paths reject.
// Since protocol 0.23.0 it also checks the extension's notification pruning
// (NotificationPruning.swift): the piggybacked `clears` parse, which delivered
// alerts a push removes, and the opaque thread identifier.
//
// Compiled and run by the "NSE crypto (swiftc)" job in ci.yml. It deliberately
// does NOT compile NotificationService.swift or SharedKeychain.swift:
// UNNotificationServiceExtension is iOS-only and the Keychain needs a signed,
// entitled process, neither of which a macOS command-line binary has.
//
// STRUCTURED AS @main RATHER THAN TOP-LEVEL CODE. Swift permits statements at
// file scope only in a file literally named `main.swift`, and this one keeps a
// descriptive name, so the entry point is an @main type instead. Writing it the
// obvious way failed to compile with "statements are not allowed at the top
// level".
//
// Usage: nseCryptoHarness <path to pushEnvelopeFixtures.json>

func hexToBytes(_ hex: String) -> [UInt8]? {
  guard hex.count % 2 == 0 else { return nil }
  var bytes = [UInt8]()
  bytes.reserveCapacity(hex.count / 2)
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
    bytes.append(byte)
    index = next
  }
  return bytes
}

func bytesToHex(_ bytes: [UInt8]) -> String {
  return bytes.map { String(format: "%02x", $0) }.joined()
}

/// A delivered or incoming alert from a match case: only what pruning reads.
func alertEnvelope(_ value: Any?) -> PushEnvelopePlaintext? {
  guard
    let fields = value as? [String: Any],
    let category = fields["category"] as? String,
    let projectId = fields["projectId"] as? String,
    let taskId = fields["taskId"] as? String,
    let sessionId = fields["sessionId"] as? String,
    let sentAt = fields["sentAt"] as? Double
  else { return nil }
  return PushEnvelopePlaintext(
    category: category,
    projectId: projectId,
    taskId: taskId,
    sessionId: sessionId,
    taskTitle: "",
    detail: "",
    sentAt: sentAt,
    clears: []
  )
}

@main
struct NseCryptoHarness {
  static func main() {
    var failures = [String]()
    var checksRun = 0

    func check(_ condition: Bool, _ message: @autoclosure () -> String) {
      checksRun += 1
      if !condition { failures.append(message()) }
    }

    guard CommandLine.arguments.count > 1 else {
      FileHandle.standardError.write(Data("usage: nseCryptoHarness <fixtures.json>\n".utf8))
      exit(2)
    }

    let fixtureURL = URL(fileURLWithPath: CommandLine.arguments[1])
    guard
      let fixtureData = try? Data(contentsOf: fixtureURL),
      let root = (try? JSONSerialization.jsonObject(with: fixtureData)) as? [String: Any],
      let pushKeyHex = root["pushKeyHex"] as? String,
      let identityPublicKeyHex = root["identityPublicKeyHex"] as? String,
      let nowMilliseconds = root["nowMilliseconds"] as? Double,
      let vector = root["hchacha20Vector"] as? [String: Any],
      let cases = root["cases"] as? [[String: Any]],
      let pushKey = hexToBytes(pushKeyHex),
      let identityPublicKey = hexToBytes(identityPublicKeyHex)
    else {
      FileHandle.standardError.write(Data("could not read the fixture file\n".utf8))
      exit(2)
    }

    // The fixture's own timestamp, not the clock. Committed fixtures would
    // otherwise age past the 24h freshness window and start failing on their own.
    let now = Date(timeIntervalSince1970: nowMilliseconds / 1000)

    // 1. HChaCha20 in isolation, against the published draft-irtf-cfrg-xchacha
    //    vector. Failing only this one points at subkey derivation rather than
    //    the nonce split or the AEAD.
    if let vectorKeyHex = vector["keyHex"] as? String,
      let vectorNonceHex = vector["nonceHeadHex"] as? String,
      let expectedSubkeyHex = vector["subkeyHex"] as? String,
      let vectorKey = hexToBytes(vectorKeyHex),
      let vectorNonce = hexToBytes(vectorNonceHex) {
      let subkey = HChaCha20.subkey(key: vectorKey, nonceHead: vectorNonce)
      check(subkey != nil, "HChaCha20.subkey returned nil for the reference vector")
      if let subkey {
        check(
          bytesToHex(subkey) == expectedSubkeyHex,
          "HChaCha20 subkey mismatch: expected \(expectedSubkeyHex), got \(bytesToHex(subkey))"
        )
      }
    } else {
      failures.append("the fixture file carried no usable hchacha20Vector")
    }

    // 2. Every sealed case, positive and negative.
    for testCase in cases {
      guard let name = testCase["name"] as? String, let blob = testCase["blob"] as? String else {
        failures.append("a fixture case was missing its name or blob")
        continue
      }

      let opened = PushEnvelope.open(
        blob: blob,
        pushKey: pushKey,
        recipientStaticPublicKey: identityPublicKey,
        now: now
      )

      guard let expected = testCase["expected"] as? [String: Any] else {
        // A null expectation: every rejection path must reject. These are the
        // ones that matter most, because the safe-looking failure is to accept.
        check(opened == nil, "case \"\(name)\" should NOT have opened, but it did")
        continue
      }

      guard let opened else {
        failures.append("case \"\(name)\" failed to open")
        continue
      }

      check(opened.category == expected["category"] as? String, "case \"\(name)\": category mismatch")
      check(opened.projectId == expected["projectId"] as? String, "case \"\(name)\": projectId mismatch")
      check(opened.taskId == expected["taskId"] as? String, "case \"\(name)\": taskId mismatch")
      check(opened.sessionId == expected["sessionId"] as? String, "case \"\(name)\": sessionId mismatch")
      check(opened.taskTitle == expected["taskTitle"] as? String, "case \"\(name)\": taskTitle mismatch")
      check(opened.detail == expected["detail"] as? String, "case \"\(name)\": detail mismatch")
      check(opened.sentAt == expected["sentAt"] as? Double, "case \"\(name)\": sentAt mismatch")

      // The composed body, so the two platforms cannot word a notification
      // differently.
      let body = CategoryCopy.body(taskTitle: opened.taskTitle, detail: opened.detail)
      if opened.taskTitle.isEmpty {
        check(body.hasPrefix("Agent session"), "case \"\(name)\": empty task title should fall back to Agent session")
      } else if opened.detail.isEmpty {
        check(body == opened.taskTitle, "case \"\(name)\": empty detail should yield the bare task title")
      } else {
        check(
          body == "\(opened.taskTitle) - \(opened.detail)",
          "case \"\(name)\": body should join the task title and detail with a single dash"
        )
      }

      check(
        CategoryCopy.title(forCategory: opened.category) != nil,
        "case \"\(name)\": no title for category \(opened.category)"
      )

      // Protocol 0.26.0's optional fields, against the protocol's own parse: an
      // unknown wait kind or a non-string title is dropped, never the alert.
      check(opened.waitKind == expected["waitKind"] as? String, "case \"\(name)\": waitKind mismatch")
      check(opened.title == expected["title"] as? String, "case \"\(name)\": title mismatch")
      check(opened.body == expected["body"] as? String, "case \"\(name)\": body mismatch")

      // What the alert presents, in decryptPushBlob's precedence. The title
      // TEXT is pinned against the TypeScript by nseConstantsParity.test.ts; this
      // pins which source wins.
      if let content = CategoryCopy.content(for: opened) {
        if let authoredTitle = opened.title, let authoredBody = opened.body {
          check(
            content.title == authoredTitle && content.body == authoredBody,
            "case \"\(name)\": a Notify me push should show its own Title and Body"
          )
        } else if opened.category == "input-required", let waitKind = opened.waitKind {
          check(
            content.title == CategoryCopy.title(forWaitKind: waitKind) && content.body == body,
            "case \"\(name)\": an input-required with a wait kind should take the kind's title over the composed body"
          )
        } else {
          check(
            content.title == CategoryCopy.title(forCategory: opened.category) && content.body == body,
            "case \"\(name)\": the alert should take its category's title over the composed body"
          )
        }
      } else {
        failures.append("case \"\(name)\": no content for category \(opened.category)")
      }

      // The piggybacked clears, against the protocol package's own tolerant
      // parse. A case that sealed none must parse none.
      let expectedClears = (expected["clears"] as? [[String: Any]]) ?? []
      check(
        opened.clears.count == expectedClears.count,
        "case \"\(name)\": expected \(expectedClears.count) clears, parsed \(opened.clears.count)"
      )
      for (index, expectedClear) in expectedClears.enumerated() where index < opened.clears.count {
        let parsed = opened.clears[index]
        check(
          parsed.category == expectedClear["category"] as? String
            && parsed.projectId == expectedClear["projectId"] as? String
            && parsed.taskId == expectedClear["taskId"] as? String
            && parsed.sessionId == expectedClear["sessionId"] as? String
            && parsed.notifiedAt == expectedClear["notifiedAt"] as? Double,
          "case \"\(name)\": clear \(index) does not match the protocol's parse"
        )
      }
    }

    // 3. Pruning: which delivered alerts an incoming push removes. The same
    //    table tests/unit/nseCrypto.test.ts runs through the app's TypeScript
    //    matcher, so the two platforms cannot disagree on it.
    let matchCases = root["matchCases"] as? [[String: Any]] ?? []
    check(!matchCases.isEmpty, "the fixture file carried no matchCases")
    for matchCase in matchCases {
      guard
        let name = matchCase["name"] as? String,
        let kind = matchCase["kind"] as? String,
        let expected = matchCase["expected"] as? Bool,
        let delivered = alertEnvelope(matchCase["delivered"])
      else {
        failures.append("a match case was missing its name, kind, expectation or delivered alert")
        continue
      }
      let deliveredList = [(identifier: "delivered", envelope: delivered)]
      switch kind {
      case "covers":
        // Through the real parser, so an entry it would drop cannot be judged.
        guard
          let rawEntry = matchCase["entry"],
          let entry = NotificationPruning.parseClearEntries([rawEntry]).first
        else {
          failures.append("match case \"\(name)\": its entry did not parse")
          continue
        }
        check(
          NotificationPruning.clearCovers(entry, delivered: delivered) == expected,
          "match case \"\(name)\": clearCovers should be \(expected)"
        )
        // And composed: an unrelated incoming push carrying the entry, which
        // cannot supersede the delivered alert on its own.
        let carrier = PushEnvelopePlaintext(
          category: "plan-complete",
          projectId: "carrier-project",
          taskId: "carrier-task",
          sessionId: "carrier-session",
          taskTitle: "",
          detail: "",
          sentAt: delivered.sentAt + 1,
          clears: [entry]
        )
        check(
          NotificationPruning.identifiersToRemove(incoming: carrier, delivered: deliveredList) == (expected ? ["delivered"] : []),
          "match case \"\(name)\": identifiersToRemove disagrees with clearCovers"
        )
      case "supersedes":
        guard let incoming = alertEnvelope(matchCase["incoming"]) else {
          failures.append("match case \"\(name)\": no incoming alert")
          continue
        }
        check(
          NotificationPruning.identityKey(incoming) == matchCase["incomingIdentityKey"] as? String,
          "match case \"\(name)\": identityKey is not the Android stable id"
        )
        check(
          NotificationPruning.supersedes(incoming, delivered: delivered) == expected,
          "match case \"\(name)\": supersedes should be \(expected)"
        )
        check(
          NotificationPruning.identifiersToRemove(incoming: incoming, delivered: deliveredList) == (expected ? ["delivered"] : []),
          "match case \"\(name)\": identifiersToRemove disagrees with supersedes"
        )
      default:
        failures.append("match case \"\(name)\": unknown kind \(kind)")
      }
    }

    // 4. The opaque thread identifier, against @noble/hashes' HKDF and HMAC.
    let threadVectors = root["threadIdentifierVectors"] as? [[String: Any]] ?? []
    check(!threadVectors.isEmpty, "the fixture file carried no threadIdentifierVectors")
    for vector in threadVectors {
      guard
        let name = vector["name"] as? String,
        let taskId = vector["taskId"] as? String,
        let projectId = vector["projectId"] as? String
      else {
        failures.append("a thread identifier vector was missing its name or ids")
        continue
      }
      let envelope = PushEnvelopePlaintext(
        category: "input-required",
        projectId: projectId,
        taskId: taskId,
        sessionId: "",
        taskTitle: "",
        detail: "",
        sentAt: 0,
        clears: []
      )
      let derived = NotificationPruning.threadIdentifier(for: envelope, pushKey: pushKey)
      check(
        derived == vector["expected"] as? String,
        "thread vector \"\(name)\": expected \(String(describing: vector["expected"])), got \(String(describing: derived))"
      )
    }

    // 5. A wrong key and a wrong AAD must fail even on an otherwise good blob.
    //    Asserted here rather than only through fixtures so the check survives a
    //    regenerated fixture file.
    if let goodCase = cases.first(where: { ($0["name"] as? String) == "good" }),
      let goodBlob = goodCase["blob"] as? String {
      var wrongKey = pushKey
      wrongKey[0] ^= 0xff
      check(
        PushEnvelope.open(blob: goodBlob, pushKey: wrongKey, recipientStaticPublicKey: identityPublicKey, now: now) == nil,
        "a flipped push key still opened the envelope"
      )

      var wrongAad = identityPublicKey
      wrongAad[0] ^= 0xff
      check(
        PushEnvelope.open(blob: goodBlob, pushKey: pushKey, recipientStaticPublicKey: wrongAad, now: now) == nil,
        "a flipped recipient public key still opened the envelope"
      )
    } else {
      failures.append("the fixture file carried no \"good\" case")
    }

    if failures.isEmpty {
      print("nseCryptoHarness: \(checksRun) checks passed across \(cases.count) fixture cases")
      exit(0)
    }

    FileHandle.standardError.write(Data("nseCryptoHarness: \(failures.count) failure(s)\n".utf8))
    for failure in failures {
      FileHandle.standardError.write(Data("  - \(failure)\n".utf8))
    }
    exit(1)
  }
}
