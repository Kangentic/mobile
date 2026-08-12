# Contributing to Kangentic Mobile

Thank you for your interest in contributing to Kangentic Mobile! This guide covers everything
you need to know to get started.

The Expo app, its test harness, and CI are all live (App Phase 2). Code contributions are welcome
alongside docs, `.claude/` conventions, and governance changes.

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
- Optional: `eas-cli` (credential management and the cloud-build fallback) and the Maestro CLI (to
  run the E2E flows in `.maestro/`)
- **No Mac is needed.** Builds run on GitHub Actions, iOS included, on free macOS runners.

### Setup

```bash
git clone https://github.com/Kangentic/mobile.git
cd mobile
npm install
npx expo start --dev-client
```

A docs or governance-only contribution needs no build step; `npm install` and the dev client are
only needed for code changes.

### Where the conventions live

The authoritative conventions for this codebase are [CLAUDE.md](CLAUDE.md) and the focused rule
files in [.claude/rules/](.claude/rules/). Each rule names how it is enforced (live now, or
planned). The sections below distill the human-relevant subset.

### Project Structure

`app/` holds thin expo-router route wrappers; screens, components, and everything else live under
`src/` (pairing, channel, connection, conversation, terminal, notifications, state, and more).
See [CLAUDE.md](CLAUDE.md)'s Project Structure section for the authoritative, current tree; this
file does not duplicate it, so the two never drift.

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

### Testing

- **Unit** (`tests/unit/`, vitest): `npx vitest run tests/unit`
- **Component** (`tests/components/`, Jest + React Native Testing Library): `npx jest tests/components`
- **E2E** (`.maestro/`, Maestro), two suites run separately, never the bare `.maestro/` root
  (which would sweep in the `setup/` rig fixture and fail confusingly):
  - smoke: `maestro --device <serial> test .maestro/smoke.yaml`, against a fresh unpaired install
  - paired: `maestro --device <serial> test .maestro/paired`, which needs a relay plus
    `scripts/stubDesktopPeer.mjs` and a completed pairing first

  Both run locally against the Android emulator and on an emulator in CI. No iOS E2E gates a PR.
  `build-ios.yml` can run the smoke flow on a macOS simulator when dispatched with
  `-f maestro=smoke`, but that path is experimental, off by default, and blocks nothing.

  **CI pins the Maestro CLI to a specific version**, so match it locally or a flow can pass on your
  machine and fail the gate. The pin is written in three places that
  `tests/unit/ciSafeMaestroFlows.test.ts` asserts agree: `.github/workflows/e2e.yml`,
  `.github/workflows/build-ios.yml`, and `.claude/rules/e2e-maestro-runs.md`, which is the one to
  read. `maestro --version` tells you what you have.

Quick local pass before opening a PR:

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
3. Run the quick local pass above
4. Sign the CLA when prompted on your first PR
5. Open the PR. The template prompts you for What / Why / How / Tests and a short checklist
6. Link any related issues

### What to expect

- **Your first PR waits on a maintainer before any check runs.** This repo uses GitHub's
  default first-time-contributor policy, so until a maintainer clicks "Approve and run
  workflows" nothing runs. The checks list reads as *empty* rather than red, which is easy to
  misread as a broken PR. If the CLA bot comment has not appeared either, that is the same gate
  rather than a broken bot. Nothing is wrong; say so in the PR thread if it sits.
- Your PR must be green on every check that registers. From
  `.github/workflows/ci.yml`, each runs as its own parallel job: **`Lint (ESLint)`**,
  **`Type check (tsc)`**, **`Unit Tests (Vitest)`**, **`Component Tests (Jest)`**,
  **`Native config (prebuild)`**, and **`Release counters (stores)`**. From
  `.github/workflows/e2e.yml`: **`E2E Tests (Maestro)`**. Plus **`cla`** (CLA Assistant).
- `E2E Tests (Maestro)` is a thin gate, the same shape as the component tier below. The work
  happens in jobs that are not themselves required: one builds a real APK, and `E2E Tests (Smoke)`
  runs the smoke flow on an Android emulator. Expect those names in the list, and expect the tier
  to take appreciably longer than the rest.
- The component tier is split across two runners. Those shards show up as their own jobs
  (`Component Tests (1/2)` and `(2/2)`) but are not themselves required: the `Component Tests (Jest)`
  gate is. The unit tier is unsharded, so `Unit Tests (Vitest)` both runs the tests and is the
  required check.
- `Release counters (stores)` guards the hand-managed `versionCode` and `buildNumber`
  against reuse. It runs on pull requests only, and it **is** required, so a red run there blocks
  the merge.
- `E2E Tests (Paired)` runs the 11 paired E2E flows and reports on every PR, but is **not** required
  and cannot block a merge. GitHub prints a "Required" badge on the checks that are, so the
  absence of one is how the list tells you. Do not silence a red run there: it is real coverage
  of the pairing ceremony and the secure channel.
- `main` is a protected branch: those checks are required, the branch must be up to date before
  merging, and force pushes and deletions are blocked.
- Android release builds and the iOS compile check are **not** PR checks. They are
  dispatch-triggered or tag-triggered, so they never gate a PR. See the CI builds section of
  [docs/developer-guide.md](docs/developer-guide.md).
- Steps that need repository secrets are skipped on a PR from a fork, by design. `Release
  counters (stores)` logs a warning reading "expected on a fork PR" and passes without contacting
  Play or App Store Connect, and the E2E build guards its keystore and `google-services.json`
  steps the same way. That is the intended fork path, not a failure.
- If a check fails, push a fix and CI re-runs automatically. Contributors cannot re-run a check
  directly, since that needs write access. To re-trigger a run for a failure unrelated to your
  change, push a new commit (an empty `git commit --allow-empty` is fine) or ask a maintainer.
  Avoid repeatedly closing and reopening the PR: each event cancels the in-flight E2E run.

### Approvals and merging

A maintainer reviews your PR and, once it is approved and green, **merges it**. Contributors do
not need write access to the repository and are not expected to merge their own PRs. Opening the
PR from your fork is all that is required from you.

A maintainer may push follow-up commits to your branch for polish or hardening before merging.
This is normal and not a reflection on your work; it is how the bar stays consistent. The
approval is a good moment to skim anything that was applied. If you want to hold the merge
(more changes are coming, or you want a different squash), say so in the PR thread.

Small, focused PRs are easier to review and merge faster.

Repeat contributors may be granted write access over time. It mainly buys smoother CI, since an
in-repo branch gets the repository secrets and skips the first-run approval gate, plus the
ability to merge your own approved PR. Until then, a maintainer lands it for you.

### UI contributions

This is a phone app, so most changes are visible ones. Include a screenshot or a short screen
recording from the emulator in the PR. It makes the review much faster and is always
appreciated. UI changes are reviewed against `.claude/rules/ui-conventions.md`: shared design-system
primitives, the font floor, FlashList for growable lists, and `testID` on interactive elements.

### How maintainers land your PR

You do not need to run any of this; it is here so the flow is not a mystery. Maintainers drive a
PR to green and merge it through an internal Kanban board: a Tests column runs `/pull-request`
(which pushes the branch and drives the CI checks to green, auto-fixing along the way), and a
Ship It column runs `/merge-pull-request` (which merges the green PR). The board mechanics, git
worktrees, and agent skills are documented in [CLAUDE.md](CLAUDE.md) and are not something a
contributor is expected to set up.

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
