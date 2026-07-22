# Rule: TypeScript style (no `any`, full descriptive names)

New code is TypeScript strict mode. Two style rules are load-bearing for maintainability: no
`any`, and no shorthand variable names.

## The rule

- **TypeScript strict mode.** New code compiles under `tsc` strict mode (`tsconfig` `strict: true`); do not loosen it.
- **No `any` types.** Never use `any` in new code. Use proper types from `@kangentic/protocol`
  for anything wire, crypto, or capability related (see `protocol-types-from-package.md`), a
  local module's own types, `unknown` with type guards, or generic constraints. Replace existing
  `any` casts when you touch the file.
- **No shorthand variable names.** Use full, descriptive names everywhere (variables, refs,
  parameters, callback arguments): `currentIndex` not `curIdx`, `previousValue` not `prev`,
  `session` not `sess`.

## Enforcement (self-maintaining)

- **Lint (live now):** ESLint `@typescript-eslint/no-explicit-any` set to `error` in
  `eslint.config.mjs`, gated by `npm run lint` in `.github/workflows/ci.yml`.
- **Type system (live now):** `tsc --noEmit` (`npm run typecheck`), gated in
  `.github/workflows/ci.yml`.
- **Review (live now):** `/code-review` and the `expo-rn-reviewer` agent flag `any` and shorthand
  names. Shorthand names are review-only (not reliably mechanizable).

## Scope

Authored TypeScript and TSX under `src/`, `tests/`, and `plugins/`.
