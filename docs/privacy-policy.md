# Kangentic Privacy Policy

Last updated: 2026-07-27

Kangentic Mobile is a remote-control companion for agent sessions running in the desktop
Kangentic app. This policy explains what the app accesses and why.

## What the app accesses

- **Camera.** Used only to scan the QR code the desktop app displays during pairing. Camera
  frames are processed on-device to read the code and are never stored or transmitted.
- **Microphone.** Used only when you tap dictation in the message composer, to turn speech into
  text via your device's built-in speech recognition. Audio is not stored or transmitted by
  Kangentic. Your device's speech engine may itself send audio to its own provider (for example
  Google or Apple) to produce the transcript; that processing is governed by your device
  provider's privacy policy, not this one.
- **Notifications.** The app registers for push notifications so the desktop can alert you to
  activity in your agent sessions. Push payloads are end-to-end encrypted ciphertext plus a
  generic placeholder; Kangentic's servers and any relay never see the plaintext content, and
  decryption happens only on your device.

## Crash reports

When the app crashes or hits an unexpected error, official builds send a crash report to
[Sentry](https://sentry.io), a third-party error-monitoring service, so the fault can be found
and fixed. This is diagnostics, not analytics: it is about the app breaking, not about you using
it.

A crash report contains the technical details of the failure and nothing else:

- the error type, message, and the stack trace showing where in the app's code it happened
- the app version, and your device model and operating system version

It deliberately does **not** contain your session content. No screenshots, no screen recording,
no on-screen text, no keystrokes, no console output, no network request details, no transcripts,
terminal output, code or diffs, no notification content, and no pairing or encryption keys. Those
are not stripped out afterwards; they are never collected in the first place.

Crash reporting also carries no identifier for you. The app does not send an account, email,
username, device identifier, or IP-based user profile with a crash report, and does not use it to
build any picture of how you use the app.

Builds you compile yourself from the open-source repository have crash reporting switched off
entirely and send nothing.

## What the app does not do

- **No account.** Pairing, transport, and notification code have no dependency on any Kangentic
  account or entitlement system. There is nothing to sign up for and no account data to collect.
- **No usage analytics or tracking.** The app does not record what you do in it, which features
  you open, how long or how often you use it, or any behavioural profile. It has no analytics
  SDK and reports no usage events. The only thing it ever reports about itself is a crash, as
  described above.
- **No sharing of your content with third parties.** The relay that carries traffic between your
  phone and desktop forwards encrypted ciphertext only, is self-hostable, and cannot read message
  content. Crash reports carry no session content either.
- **No data sale.**

## Connection and delivery metadata

Content is end-to-end encrypted, but carrying it still involves infrastructure that sees some
metadata. We would rather say so than imply otherwise.

- **The relay** sees source and destination IP addresses, connection timing, and frame sizes and
  frequency. It cannot read message content. You can avoid a Kangentic-operated relay entirely by
  self-hosting your own.
- **Push delivery** goes through Expo's push service and the platform push networks (Firebase
  Cloud Messaging on Android, APNs on iOS). Those services see your device's push token and
  delivery timing. They receive only the encrypted payload and the generic placeholder text, never
  the decrypted content.
- **Crash reporting** goes to Sentry, and only when the app actually fails. Sending a crash
  report necessarily reveals your device's IP address to Sentry, as any network request does.

## Data storage

Pairing keys and trust anchors are stored using your device's secure hardware-backed storage
(Keychain on iOS, Android Keystore on Android). Session content lives only in memory on your
device while the app is running: it is never written to a Kangentic-operated server, nor to any
third-party service. The only data that leaves your device and is stored elsewhere is a crash
report, which is retained by Sentry for 30 days and contains no session content.

## Changes to this policy

If this policy changes, the update date above will change and the revised policy will be
published at the same URL.

## Contact

Questions about this policy can be raised via the project's GitHub repository.
