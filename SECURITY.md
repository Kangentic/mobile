# Security Policy

Kangentic Mobile pairs to, and remotely steers, agent sessions on a desktop machine that can
edit code and execute commands. A vulnerability here has an unusually high blast radius; please
report it responsibly. See [docs/security.md](docs/security.md) for the full threat model and
design.

## Supported Versions

This project is pre-release. Security fixes land on `main` only; there are no maintained release
branches yet.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

1. **Preferred:** use
   [GitHub's private vulnerability reporting](https://github.com/Kangentic/kangentic-mobile/security/advisories/new)
   for this repository.
2. **Fallback:** email `security@kangentic.com` with a description of the issue, the affected
   component, and reproduction steps if you have them.

Include, where possible: the affected file or flow, the impact you believe it has, and a
proof-of-concept or reproduction steps. You do not need to have a fix in hand.

### What to expect

- **Acknowledgment** within 72 hours.
- **Triage** within 7 days: we will confirm the report, assess severity, and let you know the
  plan.
- **Coordinated disclosure** target of 90 days from acknowledgment, or sooner once a fix ships.
  We will work with you on timing if you need it published faster or slower.
- **Credit** offered in the fix's release notes if you would like it. There is no bug bounty
  program at this time.

## Scope

| Component | Report here or elsewhere |
|---|---|
| This app (pairing, secure channel, notification handling, UI) | Here |
| `kangentic-relay` (the blind byte-forwarder) | [kangentic-relay](https://github.com/Kangentic/kangentic-relay) |
| The desktop bridge, `@kangentic/protocol`, or the desktop app itself | [kangentic](https://github.com/Kangentic/kangentic) |

If you are not sure which repo a finding belongs to, report it here and we will route it.

## An auditable core is a feature

The pairing and transport crypto in this project is intentionally open source so it can be
independently audited. If you are a security researcher interested in reviewing the design
before it ships in App Phase 1, `docs/security.md` is the place to start, and we welcome that
review through the same reporting channel above.

## What is NOT a vulnerability

- **The relay seeing connection metadata.** A blind relay (self-hosted or Kangentic-hosted)
  still sees source and destination IPs, connection timing, frame sizes and frequency, and the
  pairing graph. This is documented, not a bug; see the honesty statement in
  [docs/security.md](docs/security.md).
- **The absence of device attestation** (Play Integrity, App Attest). This is a deliberate
  non-goal so sideloaded and F-Droid-style builds keep working; see
  [docs/security.md](docs/security.md).
