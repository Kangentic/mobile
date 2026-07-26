# Kangentic Privacy Policy

Last updated: 2026-07-26

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

## What the app does not do

- **No account.** Pairing, transport, and notification code have no dependency on any Kangentic
  account or entitlement system. There is nothing to sign up for and no account data to collect.
- **No analytics or tracking.** The app does not collect usage analytics or behavioral data.
- **No third-party sharing of your content.** The relay that carries traffic between your phone
  and desktop forwards encrypted ciphertext only, is self-hostable, and cannot read message
  content.
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

## Data storage

Pairing keys and trust anchors are stored using your device's secure hardware-backed storage
(Keychain on iOS, Android Keystore on Android). Session content lives only in memory on your
device while the app is running; nothing is persisted to a Kangentic-operated server.

## Changes to this policy

If this policy changes, the update date above will change and the revised policy will be
published at the same URL.

## Contact

Questions about this policy can be raised via the project's GitHub repository.
