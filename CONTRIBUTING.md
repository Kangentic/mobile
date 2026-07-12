# Contributing to Kangentic Mobile

Thank you for your interest in contributing to Kangentic Mobile! This guide covers everything
you need to know to get started.

**App Phase 0 note:** this repo currently contains only documentation, agent tooling, and
governance; the Expo app itself lands in App Phase 1. Contributions to docs, `.claude/`
conventions, and this governance layer are welcome now.

## Contributor License Agreement (CLA)

**All contributors must sign a CLA before their first pull request can be merged.**

When you open your first PR, the CLA Assistant bot will post a comment asking you to sign. You
sign by adding a comment to the PR. It takes about 30 seconds and only needs to be done once.

### Why we require a CLA

Kangentic Mobile is dual-licensed. The public open-source version uses the
[AGPLv3 license](LICENSE), and we also offer commercial licenses for organizations that need
proprietary modifications, matching the desktop [Kangentic](https://github.com/Kangentic/kangentic)
repo's licensing. The CLA ensures we can continue offering both licensing options as the project
grows.

**What the CLA says (in plain language):**

- You grant VORPAHL LLC a perpetual, worldwide, non-exclusive, royalty-free license to use,
  modify, sublicense, and distribute your contribution under any license
- You retain full copyright to your contribution. You can use it however you want
- You confirm you have the right to make this grant (i.e., you wrote the code yourself or have
  permission)
- If your contribution includes third-party code, you must identify it and its license in the
  PR description

The CLA is modeled after the
[Apache Individual Contributor License Agreement](https://www.apache.org/licenses/icla.pdf). The
full text is in [CLA.md](CLA.md).

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (see `.nvmrc`)
- JDK 17 and Android Studio with an Android Virtual Device configured (the emulator is the daily
  local target)
- Git 2.25+
- Optional: `eas-cli` and the Maestro CLI (needed once App Phase 1 lands)
- **No Mac is needed.** iOS builds and iOS E2E both run in the cloud via EAS.

### Setup

Once App Phase 1 lands the Expo scaffold:

```bash
git clone https://github.com/Kangentic/mobile.git
cd mobile
npm install
npx expo start --android
```

Today, this repo has no `package.json`; a docs or governance contribution needs no build step.

### Where the conventions live

The authoritative conventions for this codebase are [CLAUDE.md](CLAUDE.md) and the focused rule
files in [.claude/rules/](.claude/rules/). Each rule names how it is enforced (live now, or
planned for App Phase 1). The sections below distill the human-relevant subset.

### Project Structure (planned)

```
app.json / app.config.ts     # Expo config; CNG only, no checked-in native projects
eas.json                     # EAS Build/Submit/Workflows profiles
plugins/                     # Local Expo config plugins
src/
  screens/        # App screens
  components/     # Design system + transcript-terminal cells
  pairing/        # QR scan, SAS confirm, device identity, key storage
  channel/        # Noise KK secure channel, relay client, capability client
  notifications/  # Push registration, E2E blob decrypt
  state/          # Zustand stores
tests/            # unit/, components/, web/
.maestro/         # Maestro E2E flows
docs/             # Architecture, developer guide, security
```

## Making Changes

### Branch Naming

Use descriptive branch names: `fix/pairing-timeout`, `feature/board-swipe`, `docs/update-security`.

### Conventions

- **Text formatting.** No em-dashes (U+2014) and no `--` used as punctuation in anything you
  author. Use a single dash for inline separators or restructure with a period.
- **TypeScript style.** Strict mode, no `any` types, full descriptive names.
- **Wire and crypto types.** Come only from `@kangentic/protocol`, never redeclared locally. See
  `.claude/rules/protocol-types-from-package.md`.
- **UI conventions.** Shared design-system primitives, FlashList for growable lists, a font
  floor, `testID` on interactive elements. See `.claude/rules/ui-conventions.md`.
- **No personal info.** The repo is public. Never hardcode usernames, emails, or
  machine-specific paths.
- **Docs stay in sync.** When you change an anchor source file, update the matching docs under
  `docs/`. See `.claude/rules/docs-stay-in-sync.md`.
- **Security-relevant contributions.** Anything touching pairing, the secure channel, key
  storage, or notification payloads is held to a higher bar; read `docs/security.md` first and
  expect a `crypto-pairing-auditor` review pass. See `.claude/rules/accountless-core.md` and
  `.claude/rules/secure-storage.md`.

### Testing (planned, App Phase 1)

- **Unit** (`tests/unit/`, vitest): `npx vitest run tests/unit`
- **Component** (`tests/components/`, Jest + React Native Testing Library): `npx jest tests/components`
- **E2E** (`.maestro/`, Maestro): `maestro test .maestro/`, locally against the Android emulator;
  iOS E2E runs on cloud simulators via EAS Workflows

Quick local pass before opening a PR (once the harness exists):

```bash
npm run typecheck
npx vitest run tests/unit
npx jest tests/components
```

### Commit Messages

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): subject`. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, `chore`, `revert`.

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes and add or update tests for them
3. Run the quick local pass above (once the harness exists)
4. Sign the CLA when prompted on your first PR
5. Open the PR. The template prompts you for What / Why / How / Tests and a short checklist
6. Link any related issues

### What to expect

- Once App Phase 1 lands `ci.yml`, your PR must be green on: **Lint (ESLint)**, **Type check
  (tsc)**, **Unit tests (Vitest)**, **Component tests (Jest + RNTL)**, **E2E tests (Maestro /
  Android)**, and **E2E tests (Maestro / iOS simulator)** (the last runs on EAS Workflows, cloud
  only). Today, the only required check is **CLA Assistant**.
- If a check fails, push a fix and CI re-runs automatically.

### Security

Never open a public issue for a security vulnerability. See [SECURITY.md](SECURITY.md).

## Finding Work

Look for issues labeled **good first issue** for approachable tasks. If you want to take on
something larger, open an issue first to discuss the approach.

## Code of Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Questions?

Open a [discussion](https://github.com/Kangentic/mobile/discussions) or comment on the
relevant issue.
