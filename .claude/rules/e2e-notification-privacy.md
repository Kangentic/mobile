---
paths:
  - "src/notifications/**"
  - "plugins/**"
  - "targets/**"
---
# Rule: push notifications carry ciphertext only

Happy, the closest prior-art app, ships notification copy through Expo/FCM/APNs in plaintext
despite claiming end-to-end encryption. That is exactly the failure this rule exists to
prevent: a push notification is a message sent through vendor infrastructure we do not control,
so it is E2E-encrypted or it is nothing.

## The rule

- Anything that leaves the device, or that is rendered before on-device decryption, is
  ciphertext plus a generic placeholder (e.g. "Agent needs attention") only. Never a task
  title, transcript snippet, or agent state in cleartext.
- Decrypt on-device: the iOS Notification Service Extension for APNs pushes, and on Android a
  headless `expo-task-manager` task for FCM data messages, which hands the result to Notifee to
  display (Notifee owns display and press events, not receipt).
- Every failure mode a running handler can reach (missing key, decrypt error, a rich
  notification that will not post) degrades to the generic placeholder. It never falls back to
  showing ciphertext or plaintext. A handler that never runs at all is the next bullet, not this
  one.
- **The one exception is a sealed CLEAR** (protocol 0.23.0, `data.clear`): it only removes
  alerts, so it never renders anything, and every failure on its path (no key, unopenable,
  stale, malformed, a non-string value) does NOTHING rather than the placeholder. A clear is
  recognised by its data KEY before anything is decrypted, so it can never fall through to the
  display path. The `clears` a visible push carries ride inside its sealed envelope and are
  applied before it is presented; a failure there costs only the clearing, never the
  notification.
- **This governs WHAT IS RENDERED, not WHETHER anything renders.** It is a privacy floor, not a
  delivery guarantee, and must not be cited as one. A data-only push has no OS-drawn notification
  behind it, so anything that stops our on-device handler from running at all (a failed task
  registration, Doze or app-standby throttling a headless launch) produces silence - which is
  correct under this rule, and is why the receive path degrades at every step it can actually
  reach rather than relying on an OS fallback that no longer exists.
- Never log decrypted notification content, even for debugging.
- The plaintext `{ taskTitle, snippet, state }` shape exists only inside the
  encrypt-on-desktop / decrypt-on-device boundary; it must never be serialized or transmitted
  as-is.

## Enforcement (self-maintaining)

- **Review (live now):** the `crypto-pairing-auditor` agent checks the push payload builder and
  the NSE/Notifee decrypt paths during `/code-review`.
- **Test (live now):** `tests/unit/backgroundPushTask.test.ts` pins that a clear displays nothing
  on every failure path, including a non-string value, and that piggybacked clears are cancelled
  before the envelope displays.
- **Tests (planned):** a unit test asserting the payload builder never emits a plaintext field,
  and a Maestro flow asserting the placeholder renders on decrypt failure.

## Scope

`src/notifications/**`, the Expo config plugins under `plugins/**` that wire the NSE and
Notifee, and the NSE native source under `targets/**`.
