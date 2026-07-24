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
- Decrypt on-device: the iOS Notification Service Extension for APNs pushes, the Android
  Notifee background handler for FCM data messages.
- Every failure mode (missing key, decrypt error, extension not running) degrades to the
  generic placeholder. It never falls back to showing ciphertext or plaintext.
- Never log decrypted notification content, even for debugging.
- The plaintext `{ taskTitle, snippet, state }` shape exists only inside the
  encrypt-on-desktop / decrypt-on-device boundary; it must never be serialized or transmitted
  as-is.

## Enforcement (self-maintaining)

- **Review (live now):** the `crypto-pairing-auditor` agent checks the push payload builder and
  the NSE/Notifee decrypt paths during `/code-review`.
- **Tests (planned):** a unit test asserting the payload builder never emits a plaintext field,
  and a Maestro flow asserting the placeholder renders on decrypt failure.

## Scope

`src/notifications/**`, the Expo config plugins under `plugins/**` that wire the NSE and
Notifee, and the NSE native source under `targets/**`.
