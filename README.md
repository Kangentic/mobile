<h1 align="center">Kangentic Mobile</h1>

<p align="center">
  <strong>Walk away from your PC. Steer your agents from your phone.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square" alt="AGPL-3.0 License" /></a>
  <img src="https://img.shields.io/badge/platform-iOS%20%7C%20Android-brightgreen.svg?style=flat-square" alt="Platform" />
  <img src="https://img.shields.io/badge/status-pre--release-orange.svg?style=flat-square" alt="Status" />
</p>

---

Kangentic Mobile is the mobile companion to the desktop
[Kangentic](https://github.com/Kangentic/kangentic) app. It pairs to your desktop, lets you see
what your agents are doing, and lets you steer them, all without giving up end-to-end encryption
or a self-hostable relay in between.

**Status: pre-release, App Phase 2.** The Expo app, pairing, secure channel, and the core
remote-control experience (triage home, board, conversation, terminal, diffs) are live; store
release and device management are still ahead. See the roadmap below.

## What it is

- A companion app for the desktop [Kangentic](https://github.com/Kangentic/kangentic) board:
  it does not run agents itself, it remote-controls sessions your desktop is already running.
- The blind relay that connects the two is [relay](https://github.com/Kangentic/relay),
  a separate, self-hostable, open-source repo.
- Wire and crypto types come from `@kangentic/protocol`, published from the desktop repo, so the
  two apps never drift on the protocol they share.

## How it works

- **Accountless QR pairing.** The desktop shows a QR code; the phone scans it. No signup, no
  account, and nothing but a single-use token and a public key ever travels in the QR.
- **End-to-end encrypted channel.** Every session runs a Noise KK handshake over a relay that
  forwards ciphertext only and reads nothing.
- **Capability allowlist, enforced by the desktop.** The channel proves which device is
  connected; a desktop-enforced allowlist decides what it may do. **The protocol has no shell,
  file, or arbitrary-command verb at all.**
- **Transcript rendered as a terminal.** The primary view reflows the agent's output to your
  phone width and streams it live, with permission prompts as tappable cards.
- **Push notifications are end-to-end encrypted.** Payloads carry ciphertext plus a generic
  placeholder only; decryption happens on-device.

See [docs/architecture.md](docs/architecture.md) for the full design.

## Roadmap

- **App Phase 0 (done):** documentation, `.claude/` agent environment, governance.
- **App Phase 1 (done):** Expo scaffold, pairing client, secure channel client.
- **App Phase 2 (this repo, now):** the core experience (triage home, board, conversation,
  terminal, diffs).
- **App Phase 3 (next):** notifications, device management, store release.

## Stack

| Layer | Choice |
|---|---|
| Framework | Expo SDK 55+, React Native New Architecture, TypeScript strict |
| State | Zustand |
| Lists | FlashList |
| Crypto | `@kangentic/protocol` (pure TypeScript on `@noble/*`), react-native-get-random-values, @bacons/text-decoder |
| Storage | expo-secure-store (Keychain / Android Keystore) |
| Notifications | Expo Push, Notifee, a native iOS Notification Service Extension |
| Build | EAS Build/Submit/Workflows (cloud), Continuous Native Generation |

## Development

Windows-first, no Mac required:

- **Android:** the emulator is the day-to-day local target (`npx expo start --dev-client`).
- **iOS:** built and signed in the cloud via EAS (`eas build --platform ios`); validated through
  TestFlight or a cloud EAS Workflow run. There is never a local iOS simulator step.
- Node version pinned in [.nvmrc](.nvmrc).

See [docs/developer-guide.md](docs/developer-guide.md) for full setup.

## Testing tiers

| Tier | Runner | Where |
|---|---|---|
| Unit | vitest | Any OS, CI |
| Component | Jest + React Native Testing Library | Any OS, CI |
| E2E | Maestro | Windows + Android emulator locally, and a CI emulator. No iOS E2E yet |
| Web | Playwright via react-native-web | Later phase |

## Security

The channel this app establishes can steer an agent that edits code and runs commands on the
paired desktop, so security is treated with a correspondingly high bar: an auditable,
open-source crypto core, no long-lived secret in the pairing QR, and end-to-end encrypted push.
A blind relay (self-hosted or Kangentic-hosted) still sees connection metadata (IPs, timing,
frame sizes); this is stated plainly, not hidden. See [docs/security.md](docs/security.md) for
the full threat model and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Self-hosting the relay

The relay is accountless by design: a Kangentic account is only ever relevant to using
Kangentic's hosted relay past a free cap. To run your own, see
[relay](https://github.com/Kangentic/relay).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). All contributors must sign a CLA (see [CLA.md](CLA.md)).

## License

[AGPL-3.0](LICENSE). If AGPL doesn't work for you, drop us a line at licensing@kangentic.com.
