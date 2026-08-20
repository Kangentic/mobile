---
description: Run a design-taste pass over a screen or component - premium, app-native, anti-generic mobile design direction adapted to Kangentic's Warm Craft system
argument-hint: [screen or component to design/review]
---

# Design Pass

Apply elite mobile design direction to Kangentic Mobile screens and components. Use this when
designing a new screen, restyling an existing one, or reviewing UI work for "does this feel
like a Fortune 500 company built it". This skill directs DESIGN JUDGMENT; the mechanical
conventions (primitives, font floor, FlashList, testIDs, touch targets) live in
`.claude/rules/ui-conventions.md` and still apply.

Distilled and adapted for this codebase from three upstream skills:
leonxlnx/taste-skill `imagegen-frontend-mobile` (art direction + anti-generic rules) and
wshobson/agents `mobile-ios-design` / `mobile-android-design` (HIG + Material principles).
Their platform-code and image-generation content is intentionally dropped; what remains is
the taste layer, rewritten against our design system.

## The Kangentic design language (the fixed frame)

Every design decision starts from what already exists. Never invent a parallel visual system.

- **Warm Craft, dark only.** Warm near-black neutrals, amber `accent` family, tokens in
  `src/components/theme/tokens.ts`. No hardcoded hex in screens or components.
- **Two-hue rule.** Amber = brand + attention (needs-you, accents, CTAs). Green = terminal
  positive (working status, success, diff adds). Yellow = warning. Do not let amber and green
  compete on one surface; one attention color per moment.
- **Brand assets with intent.** Brandmark in chrome, Overseer mascot ONLY in the closed
  placement list (empty states, pairing); never sprinkle it as decoration.
- **Icons are lucide** (`lucide-react-native`), matching the desktop app. The upstream taste
  skill warns against "generic Lucide-like defaults" - our answer is intent, not a different
  library: pick the icon that names the action precisely, keep one size/stroke rhythm per
  surface, and pair icons with labels when the meaning is not universal (a red `^C` glyph is
  a failure; an octagon-X labeled "Stop" is the fix).
- **Terminal is the soul.** The transcript-as-terminal and mono type are the product's
  identity. Chrome around the terminal defers to it: calm, low-contrast surfaces, no
  decoration competing with live PTY output.
- **Motion rich but restrained.** Use `MotionTokens` presets and the closed haptic cue list.
  Animate containers, never FlashList item roots. Everything respects reduced motion.
  `.claude/rules/motion-conventions.md` is the full bar and the single source of truth: read it
  before proposing any motion change, and gate on frequency first (something the user sees 100+
  times a day earns the platform default or nothing, so the right call is often to delete the
  animation rather than tune it).

## Design principles (the taste layer)

1. **Attention hierarchy above all.** Each screen answers one question first (Home: "what
   needs me?"). One primary focal point, one clear next action. If two elements fight for
   attention, demote one.
2. **Full-bleed, no dead bands.** Content surfaces (terminal, chat, diffs) own the full
   viewport. Safe-area insets are handled deliberately per edge (headers own the top inset;
   footers own the bottom); a visible seam or double inset is a defect, not a nitpick.
3. **Constant geometry across mode switches.** Toggling a lens (terminal/chat) must not shift
   shared chrome by a pixel. Shared footers/headers own their border and padding; children
   render content only.
4. **Clean over simple.** Screens may be rich and layered (status rails, badges, mono
   summaries) as long as hierarchy stays readable. Do not flatten a screen into emptiness and
   call it minimal; do not stack cards-in-cards and call it rich. One strong structural move
   per surface beats five weak ones.
5. **Comfortable density.** Generous spacing between major blocks, breathing room inside
   cards, and the 12px font floor is a floor, not a target. If text feels small, the design
   is not finished: simplify the layout instead of shrinking type.
6. **Believable states.** Every screen designs its loading (skeletons), empty (Overseer +
   one-line guidance + CTA), error (plain words + retry), and disconnected states with the
   same care as the happy path. A spinner in a void is not a state design.
7. **Platform-native feel.** Bottom-tab reachability, thumb-zone placement for primary
   actions (the mode pill docks at the input bar, not the header), sheets for secondary
   tasks, back affordances that match the platform. Android first here; iOS parity later.
8. **Copy is UI.** Short, concrete, product-true labels ("Review and approve", "Stop the
   running agent"). No filler ("Seamless control"), no jargon the user didn't type, no
   unexplained glyphs.

## Anti-generic tells (reject on sight)

- Purple-blue startup gradients, glassmorphism without purpose, ambient blobs.
- Widget-spam dashboards; repeated stat cards with no product reason.
- Pills/badges/micro-labels multiplying until nothing reads as important.
- A "website in a phone": edge-to-edge poster layouts ignoring safe areas and nav reality.
- Cloned sibling screens (every list screen identical) OR sibling screens that drift into
  different design systems. Vary composition, keep the system.
- Icon-only controls for destructive or ambiguous actions.
- Hardcoded colors, one-off buttons, or spacing literals bypassing tokens (also a rule
  violation, but it is a taste failure first).

## Procedure

1. Read the target screen/component plus `tokens.ts` and its neighbors (siblings on the same
   navigation level) so the pass designs in context, not in isolation.
2. State the screen's one question and its primary action. If you cannot, that is the finding.
3. Walk the principles and anti-tells above against the current implementation; list concrete
   defects with file:line.
4. Apply fixes with design-system primitives and tokens only. New primitives go in
   `src/components/` with testIDs and a component test.
5. Verify visually on the emulator via `node scripts/mobileInspect.mjs screenshot` (the
   inspect loop), at minimum: default state, keyboard open (if input exists), empty state,
   and both lenses for session surfaces.
6. Run the touched component tests plus `npm run typecheck`.

## Scope

Design judgment for `src/screens/**` and `src/components/**`. Mechanical conventions stay in
`.claude/rules/ui-conventions.md`; this skill never overrides a rule, and the user's explicit
direction overrides this skill.
