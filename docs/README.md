# Documentation

Kangentic Mobile is a mobile companion app that pairs to, and remotely steers, agent sessions
running in the desktop [Kangentic](https://github.com/Kangentic/kangentic) app. These docs
describe the architecture as of App Phase 2. The durable research behind these decisions lives
in the desktop repo's
[`docs/research/mobile-companion-app.md`](https://github.com/Kangentic/kangentic/blob/main/docs/research/mobile-companion-app.md).

## Start Here

| If you are... | Read |
|---|---|
| Contributing code | [developer-guide.md](developer-guide.md) |
| Understanding the system | [architecture.md](architecture.md) |
| Reviewing the security design or reporting a vulnerability | [security.md](security.md), [SECURITY.md](../SECURITY.md) |

## Reference

- [developer-guide.md](developer-guide.md) - setup, build system, testing tiers, EAS.
- [architecture.md](architecture.md) - pairing, secure channel, capability allowlist,
  transcript-terminal rendering, notifications.
- [security.md](security.md) - threat model, the pairing ceremony's crypto detail, key storage,
  the relay's blind-metadata honesty statement.
- [pre-live-hardening-summary.md](pre-live-hardening-summary.md) - the pre-live baseline: what is
  proven on real hardware, what only tests cover, and what has never been verified at all
  (iOS, chiefly). Read this before trusting a platform claim about this app.
