# Kangentic Mobile

Mobile companion app that remote-controls agent sessions running in the desktop Kangentic app.

## Tech Stack

- **Framework:** Expo SDK 55+, React Native New Architecture, TypeScript strict mode
- **State:** Zustand
- **Lists:** FlashList (transcript feed, board, chat-style streaming)
- **Crypto:** `@kangentic/protocol` (pure TypeScript on `@noble/curves`/`@noble/hashes`/`@noble/ciphers` -
  no native crypto module; the same handshake code runs on Node and Hermes), plus
  `react-native-get-random-values` (CSPRNG polyfill) and `@bacons/text-decoder` (Hermes has no
  built-in `TextDecoder`)
- **Storage:** expo-secure-store (Keychain / Android Keystore)
- **Notifications:** Expo Push, Notifee (Android), a native iOS Notification Service Extension via config plugin
- **Build:** EAS Build/Submit/Workflows (cloud, including all iOS builds), Continuous Native Generation (no checked-in native projects)
- **Testing:** vitest (unit), Jest + React Native Testing Library (components), Maestro (E2E, Windows + Android emulator locally, EAS Workflows cloud iOS simulators), Playwright via react-native-web (later)

## Project Structure

**Scaffolded - App Phase 1.** `app/` holds thin expo-router route wrappers; the actual screen
implementations and everything else live under `src/`. If the layout changes, update this tree
and the rule `paths:` globs together.

```
app.config.ts                 # Expo config; CNG - config plugins only, no checked-in native projects
eas.json                      # EAS Build/Submit/Workflows profiles (development/preview/production)
app/                           # expo-router route wrappers (thin - render the src/screens/ implementation)
  _layout.tsx, (tabs)/         # root Stack + bottom Tabs (Home, Board)
  pair.tsx, pair-confirm.tsx    # pairing flow routes; pair.tsx renders the scan/paste screen (OS deep-link routing of kangentic-pair:// is a later phase)
  settings.tsx, devices.tsx
plugins/                      # Local Expo config plugins (NSE injection, keychain access group, notifee) - later phase
targets/nse/                  # iOS Notification Service Extension source, injected via plugin - later phase
src/
  screens/        # TriageHome, Board, Pairing (Scan/Confirm), Settings, Devices
  components/     # Design system primitives (Screen/Text/Button/Card/...) + theme tokens
  pairing/        # QR validation, device identity, the IKpsk0 pairing state machine, trust anchor storage
  channel/        # Relay WebSocket transport, KK session manager (responder), slot derivation, capability client
  notifications/  # Push registration, E2E blob decrypt, category prefs, presence suppression - later phase
  state/          # Zustand stores (activity/board mock data, pairing, channel - all in-memory)
  lib/            # Shared pure utilities (crypto polyfills)
tests/
  unit/           # vitest (pure TS, no RN runtime) - includes the loopback-transport + stub-desktop-peer helpers
  components/     # Jest + React Native Testing Library
  web/            # Playwright via react-native-web (later)
.maestro/         # Maestro E2E flows
scripts/          # bash-guard.js + repo scripts
```

## Commands

- `npm install` - Install dependencies
- `npx expo start --dev-client` (`npm start`) - Start the dev server against a dev-client build
- `npx expo start --android` (`npm run android`) - Start the dev server against the Android emulator
- `eas build --profile development --platform android` - Build a dev-client for local iteration
- `eas build --profile production --platform ios` - Build for the App Store (cloud, no Mac needed)
- `npm run typecheck` - `tsc --noEmit`
- `npm run lint` - `eslint . --max-warnings 0`
- `npm run test:unit` - Unit tests (`vitest run tests/unit`)
- `npm run test:components` - Component tests (`jest tests/components`)
- `maestro test .maestro/` - E2E flows against the Android emulator
- `eas update` - Push a JS-only OTA update

## Architecture

Full detail lives in [docs/architecture.md](docs/architecture.md) and
[docs/security.md](docs/security.md); this is the always-visible summary.

- **Pairing:** the desktop displays a QR (its static public key, a short-lived single-use
  high-entropy token, a relay address, a protocol version), the phone scans it. The token is
  mixed into the Noise handshake as a **pre-shared key**, not used in a PAKE - this is a
  deliberate deviation from the original research doc's SPAKE2 recommendation; see
  `docs/security.md` for why a high-entropy scanned token makes a PAKE unnecessary. After the
  handshake, both sides confirm a transcript-derived SAS (Short Authentication String) before
  the pairing completes.
- **Secure channel:** every session runs a fresh Noise KK handshake
  (`Noise_KK_25519_ChaChaPoly_BLAKE2s`) over a blind, self-hostable relay
  (`kangentic-relay`, a separate repo) that forwards ciphertext only. The desktop always
  initiates the KK handshake and owns the ~2 minute rekey timer; the phone is the responder.
  Version negotiation is bound into the prologue to close downgrade attacks.
- **Capability allowlist:** the channel proves which device is connected; a desktop-enforced
  allowlist decides what it may do. Six v1 verbs (`read-stream`, `read-board`, `read-diff`,
  `send-user-message`, `move-task`, `answer-permission-prompt`). **There is no shell, file, or
  arbitrary-command verb in the protocol - absent, not filtered.**
- **Transcript-terminal rendering:** the primary session view renders the transcript styled as a
  terminal, reflowed to phone width and streamed token-by-token, with `AskUserQuestion`/
  permission prompts as tappable cards. A raw interactive terminal mirror is a secondary view.
- **E2E push:** payloads are ciphertext plus a generic placeholder only; decryption happens
  on-device (iOS Notification Service Extension / Android Notifee). Every failure degrades to
  the placeholder, never to plaintext.
- **Accountless core:** pairing, transport, and capability code never depend on any Kangentic
  account or entitlement layer. The open-core split (this app is open source and self-hostable;
  a Kangentic-operated hosted relay is the paid product) depends on this separation holding.
- **CNG:** native config flows through `app.config.ts` and Expo config plugins under `plugins/`.
  `ios/` and `android/` are gitignored prebuild artifacts, never hand-edited or committed.

## Testing

Four tiers, chosen for the fastest tier that proves the behavior. Full detail:
[docs/developer-guide.md](docs/developer-guide.md).

**Always fine:**
- `npm run typecheck` - run freely at any point (once it exists).
- Running tests you just added or modified, scoped to those files.

**Never run unless the user explicitly asks, or `/test` is executing:**
- An unscoped full-tier run (`npx vitest run` with no path, `maestro test .maestro/` for the
  full suite).

If a run would execute tests you did not add or modify, it is a full-tier run: stop and let
`/test` handle it.

**Phase 0 note:** the harness (vitest, Jest+RNTL, Maestro) does not exist yet. Until App Phase 1
scaffolds it, `/test` and `test-builder` operate in audit/plan mode only.

## Conventions

Enforceable standards live as focused, auto-loaded rules in `.claude/rules/`. Rules without a
`paths:` header load every session; rules with one load when you touch matching files. Each rule
names its enforcement (live now, or planned for App Phase 1).

**Always-on rules:**
- `bash-single-command.md` - one command per Bash tool call; no `&&` `||` `|` `;` or redirects.
- `text-formatting.md` - no em-dashes (U+2014) or `--` as punctuation in authored text.
- `typescript-style.md` - TypeScript strict mode; no `any` types; full descriptive names.
- `no-personal-info.md` - no usernames, emails, or machine paths in committed code (repo is public).

**Path-scoped rules (load with their subsystem):**
- `protocol-types-from-package.md` - wire/crypto/capability types come only from
  `@kangentic/protocol`, never redeclared (`src/**`).
- `accountless-core.md` - pairing/transport/capability code has no account/entitlement imports
  (`src/pairing/`, `src/channel/`, `src/notifications/`).
- `e2e-notification-privacy.md` - push payloads are ciphertext plus placeholder only
  (`src/notifications/`, `plugins/`, `targets/`).
- `expo-cng.md` - no hand-edited `ios/`/`android/`; native config via config plugins
  (`app.json`, `app.config.*`, `eas.json`, `plugins/`, `ios/`, `android/`).
- `secure-storage.md` - long-lived secrets in `expo-secure-store`, never AsyncStorage
  (`src/pairing/`, `src/channel/`, `src/notifications/`, `src/state/`).
- `ui-conventions.md` - shared primitives, font floor, FlashList, testIDs (`src/screens/`,
  `src/components/`).
- `docs-stay-in-sync.md` - update docs when changing anchor source files.

**Local overrides:** there is no per-rule local file. Put machine-specific instruction overrides
in a gitignored `CLAUDE.local.md` at the project root.

**Other conventions (workflow, not extracted to rules):**
- Prefer editing existing files over creating new ones.
- A plain **local commit** goes through `/commit`: it stages and commits on the current branch
  only, with no push and no rebase. A bare request to "commit" means `/commit`.
- **Landing changes goes through a PR by default.** The board drives it: the **Tests** column
  runs `/pull-request` (commit, conventional branch, push, create the PR, drive its CI checks to
  green), and the **Ship It** column runs `/merge-pull-request` (merge the green PR, pull back to
  local `main`). For a deliberate direct quick-push that bypasses the PR gate, use `/merge-back`.
  Only push, land, or merge when the user explicitly asks.
- `/commit`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all write conventional-commit
  messages.
- `/sync-docs` keeps `docs/` aligned with source; the doc-anchor check runs inside `/pull-request`
  (commit time) and `/merge-pull-request` (merge time), and `/merge-back` for direct pushes.

### Authoring a rule

When you codify a new convention, add it as a `.claude/rules/*.md` file following the existing
ones:

1. **One concern per file**, with a descriptive kebab-case filename.
2. **Decide loading, and keep always-on rules few.** Always-on rules (no frontmatter) load every
   session and cost context every session, so reserve them for universal, file-independent
   conventions. Everything subsystem-specific gets `paths:` frontmatter. Treat ~4 always-on as
   a soft ceiling.
3. **Mind the read-trigger gap.** A path-scoped rule loads when a matching file is read into
   context, not when Claude creates a new file in that path. So (a) any convention that must
   hold at file-creation time belongs in an always-on rule or a hook, never path-scoped-only;
   and (b) every path-scoped rule should have a backstop (a future test, or a review-time
   auditor agent) so a missed load is still caught.
4. **Structure:** a one-paragraph context (the problem / the bug it prevents), `## The rule`
   (prescriptive), `## Enforcement (self-maintaining)`, and `## Scope`.
5. **Name an enforcement, strongest available.** A hook blocks 100%; a test or lint rule runs in
   CI; a review-time auditor agent or `/code-review` is the probabilistic fallback. Flag
   explicitly where mechanical coverage is missing (most of this repo's rules are review-only
   until App Phase 1 adds the test harness).
6. **Update the index above** with a one-line pointer, and add a backlink from the enforcing
   agent or skill so the rule stays the single source of truth.
7. **Route agents deliberately.** When authoring or updating a skill, decide whether it needs a
   fresh context (a review or audit skill) or should fork the current session (continuing an
   in-flight task); never route a mutating skill to a read-only agent type.

**Linting:** planned for App Phase 1 (`eslint src/ --max-warnings 0` wired into CI). Until then,
the conventions above are enforced by review (`/code-review`, `crypto-pairing-auditor`,
`expo-rn-reviewer`) rather than mechanically.
