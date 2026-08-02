# Design: mobile terminal ownership and a stable phone grid

Status: **proposal**. Decisions captured from an interview on 2026-08-01. No code written for
the ownership model. Discussion resumes 2026-08-02.

Two earlier drafts were retracted during the interview and are recorded here so they are not
re-proposed: a *pinned global grid* (changed desktop rendering for every session, rejected as
too invasive) and *fixed mobile zoom only* (mobile-only, but leaves the grid unstable so the
content still reflows).

## The problem

One PTY per session, one grid. Today that grid is whatever desktop surface most recently laid
itself out (`FitAddon` -> `terminal.onResize` -> `sessions.resize`). Measured live:

| Surface | Host width | Grid |
| --- | --- | --- |
| bottom-panel | 2154px | 306x14 |
| board-window (task detail) | 1482px | 210x48 |
| spawn default, nothing mounted | n/a | 120x30 |

The phone mirrors 1:1 because the bytes are cursor-addressed for that grid, so it inherits
every shape. Two symptoms: a short desktop grid renders as a strip on the phone, and text size
jumps whenever a desktop window changes.

## Core decision

The phone **takes ownership of the terminal** and requests its own grid, rather than mirroring
whatever the desktop left behind. Ownership is mutually exclusive and arbitrated in main,
reusing the existing task-detail ownership machinery.

This is viable with no security-model change: `interactive-terminal` (with its `resize` and
`release-size` actions) is **already granted by default**.

```ts
// pairing-service.ts:28
export const DEFAULT_PAIRING_CAPABILITIES: CapabilityVerb[] = [...CAPABILITY_VERBS];
```

The rationale is recorded there: the phone is an extension of the user's own desktop, and the
QR scan plus SAS comparison already proves physical possession of both devices. What stays
true regardless is the real guardrail: the protocol defines no shell, file, or
arbitrary-command verb at all, so "full access" means those ten and never more.

> **Doc bug to fix:** the mobile repo's `CLAUDE.md` states the default grant is "the read-only
> four plus `register-push`, and every write/control verb needs an explicit per-verb grant".
> That contradicts the desktop's actual code and misled this design discussion once already.

## Ownership model

### The unit is the TERMINAL, not the task detail

`DetailOwnerRegistry` currently arbitrates task details, specifically to enforce
one-xterm-per-session. Here the desktop must still be able to open Changes or Chat for a task
whose terminal the phone holds. So the owned thing narrows to the terminal, and a desktop
detail can be open with its terminal suppressed.

This is a change to the registry's *meaning*, not just a new enum member.

### The rules already exist

`detail-owner-registry.ts:4-13` already implements what we want:

1. A given detail can never be open twice.
2. **The requester wins.** Deliberately no placement heuristic, so behaviour never depends on
   state the user cannot see.

Changes needed: `DetailHost` widens from `'board' | 'monitor'` to include `'mobile'`, and
`DetailOwner`'s identity widens from `webContentsId` to also accept a device id.

Why this invariant matters (`detail-owner-registry.ts:20-22`): two hosts mounting the same task
would each mount a terminal for its session, and the PTY backpressure protocol assumes a
single acking reader. Today the phone sidesteps this by tapping output outside the
backpressure accounting; making it a real host puts it under the invariant instead of beside
it.

### Who holds, and when

- The phone holds while its **Terminal lens is open AND the app is foregrounded**.
- Backing out of the Terminal lens releases immediately, so the desktop resumes instantly.
- The phone takes control **as soon as the Terminal lens loads**, including from a push
  notification tap. There is deliberately no "desktop is driving" state on the phone: on the
  phone the user is on the road and needs to interact, so mobile intent always wins.
- Only one phone ever connects. For plumbing, first-holder-wins.

**Proposed, needs confirmation.** Two answers in the interview pulled against each other: the
phone should keep control through a notification glance, but the desktop should not have to
fight a Resume button when the phone is not actively looking. Proposed boundary: a **~10s
grace period** on background before releasing. A glance keeps the hold; walking to your desk
and opening the task finds no active holder and just takes it. The mirrored-plus-Resume state
then only appears when the phone genuinely is live on that terminal.

### What each side shows

**Desktop, while the phone holds:** the phone's grid rendered **letterboxed and centered**,
dimmed margins, with a **"Resume Control"** overlay button.

The sizing concern raised in the interview was that a phone-shaped grid would make the desktop
look broken. It does not. A 60x40 phone grid at the desktop's own 7.0 x 17.0px cell size is a
**420 x 680px** block inside a 1470 x 816px panel: 29% of the width, full height. That reads as
"this is the phone's screen". Filling the width instead would need a ~49px font and 1960px of
height, so letterboxing is the only viable option and also the one that communicates best.

Every first-class terminal surface (board task detail, monitor, command terminal) offers Resume
Control. Start uniform and let the desktop UI decide when a detail is shown at all.

**Desktop, taking over:** Resume Control reclaims the grid. The phone drops to the agents view.

**Phone, when the desktop reclaims:** falls back to the **Chat lens on the same task**, with a
banner ("Terminal is on desktop"). Not the agents view, and never a silently-changed terminal.

The rejected alternatives and why: a silent revert to mirroring reads as a rendering bug, which
is the exact failure this design is trying to remove; ejecting to the agents view is
unambiguous but throws away the user's place, and the likeliest moment for a desktop takeover
is precisely when the user has walked back to their desk mid-read. Chat keeps the content
readable, reflowed to phone width, and scrollable, on a surface that already exists and already
degrades agent-agnostically. The agents view remains the fallback only if the task itself goes
away.

**No grace period.** Backgrounding or leaving the Terminal lens releases immediately; whichever
surface wants the terminal takes it. A timer was considered and rejected: it is hidden state
that makes behaviour harder to predict, and its only benefit is avoiding repaint churn on a
notification glance, which is measurable rather than structural. Revisit only if that churn
proves annoying in real use.

### Release paths are already built

`terminal-size-guard.ts` registers the restore AS a subscription teardown, so all of these work
with no new lifecycle plumbing:

| Trigger | Restores desktop dims? |
| --- | --- |
| explicit `release-size` | yes |
| phone transport drops | yes |
| device revoked in settings | yes |
| bridge shutdown | yes |
| session exits | no, disarms (a respawn spawns at desktop dims anyway) |

Contention is latest-writer-wins, and a desktop resize while the phone holds updates the
guard's restore target.

## The phone's grid

- **Column count is a user setting**, globally applied. Ship both a raw slider and
  Narrow/Standard/Wide presets, so the right values are found by testing rather than guessed.
  Candidate anchors: 60, 80, or derived from device width.
- Phone dimensions drive the min/max of the allowed range.
- Rows derive from device height at the resulting cell size.
- **Pinch-zoom never changes the grid.** Pure visual scale, so zooming costs no SIGWINCH and no
  agent repaint, and content never reflows under the user's fingers. The intended feel is a
  wider-than-screen terminal the user pans across, not a condensed one.
- **Portrait only.** All of the app's content is vertical.

## The fallback path still matters

When the phone cannot hold the grid (session not running, resize rejected, or the gap between
opening the lens and the desktop acknowledging), it renders whatever grid exists. That is the
mirror path, and the measured height fit plus short-grid centring is what makes it degrade
gracefully instead of clipping the last row.

Keep that work. It is the floor under the new behaviour.

## Scrolling history on the phone: a missing gesture, not missing data

**Diagnosis confirmed 2026-08-02.** The desktop scrolls a session's history perfectly today.
That is NOT terminal scrollback.

These sessions run Claude Code with `/tui fullscreen`, so the agent lives permanently in the
**alternate buffer**, which has no scrollback on either side. What actually happens on the
desktop is that xterm translates a mouse **wheel** into arrow-key sequences and sends them to
the application, which scrolls itself. The bundled xterm contains exactly that construction,
gated on `hasScrollback`:

```js
ESC + (applicationCursorKeys ? 'O' : '[') + (deltaY < 0 ? 'A' : 'B')
```

The phone does not scroll because a touch drag generates no wheel event, so nothing is sent.

Consequences:

- **No desktop change needed**, at all. Entirely mobile-side.
- **No protocol change needed.** Arrow keys are terminal input and `interactive-terminal` is
  already granted by default.
- **The mechanism already exists on the phone**: the `↑` / `↓` quick keys send arrow sequences,
  and the page already tracks `lastAppCursorMode` so it knows whether to emit `ESC[A` or
  `ESCOA`. Tapping `↑` should already scroll history today (unverified on device).

**Shipped and verified on a Pixel 10 (2026-08-02, commit `c3a8e77`).** Both directions scroll,
the input box stays empty, and no "sending arrow keys" warning appears.

Two earlier attempts failed on hardware while passing their tests. Recorded so neither is
retried:

1. **Arrow keys.** Claude Code reads them as input-history navigation, so a drag recalled the
   previous message into the composer. The agent even says so on screen: *"Scroll wheel is
   sending arrow keys - use PgUp/PgDn to scroll"*.
2. **Arrows via a synthesized wheel.** Same destination, because xterm's alt-buffer branch
   converts an unconsumed wheel straight back into those arrows.

The mistake behind both was reading only the FIRST branch of xterm's alt-buffer wheel handler.
The whole thing is:

```js
if (!buffer.hasScrollback) {
  if (coreMouseService.consumeWheelEvent(...) === 0) return cancel();   // mouse report wins
  ... else emit ESC [ A / ESC [ B                                        // fallback only
}
```

So the working design picks the mechanism the buffer and mode actually allow, preferring the
smooth one:

| Mechanism | When | Granularity |
| --- | --- | --- |
| `viewport` | normal buffer, real scrollback | line, local, no network |
| `wheel` | alt buffer + mouse tracking | line; xterm encodes the mouse report, same as a desktop wheel |
| `page` | alt buffer, no tracking | page (PgUp/PgDn), steppier, fallback only |

The drag unit follows the mechanism, so content tracks the hand roughly 1:1 either way. A burst
is always posted as ONE write, never one message per unit.

When the user has zoomed in far enough that the grid overflows vertically, drag pans first and
chains into history scrolling at the top edge (standard overscroll).

### Smoothness expectations, stated honestly

| Gesture | Resolves | Feel |
| --- | --- | --- |
| Pinch zoom | local | smooth |
| Pan | local | smooth |
| History scroll, normal buffer | local | smooth |
| History scroll, ALTERNATE buffer | round-trips to the agent | **stepped, not buttery** |

The last row is inherent. In the alternate buffer the phone holds exactly one screen, so there
is no local history to scroll and every scroll position must ask the agent to redraw and stream
back. Batching makes a fling one round trip instead of N, so it reads as a single responsive
jump rather than a glide.

The product already has the answer for fast reading: **the Chat lens** is local, fully
scrollable, and reflowed to phone width. Terminal scroll is for nudging the live view; Chat is
for reading what happened.

Measure the input-to-repaint round trip early, since it decides whether stepped scrolling reads
as responsive or sluggish.

Note this also explains why the phone's `scrollback: 2000` setting has never helped: in the alt
buffer there is nothing in it to reach.

## The one case ownership does not cover

When nobody holds a terminal (phone released, no desktop surface open), the PTY sits at
whatever it was last set to. If the bottom panel touched it, that is **306x14**, and the agent
keeps running in a 14-row letterbox with nobody watching.

That is not a mobile problem. A 14-row grid is bad for the agent's own TUI. The resting-grid
park addresses exactly this and survives independent of everything above.

## Why ownership cannot be deferred

An earlier draft of this doc suggested the phone could request its own grid without the
ownership registry, relying on latest-writer-wins for takeover. **That is wrong and must not be
built.**

Without the registry the phone cannot distinguish two very different events, because both
present identically as "the grid changed":

- **Deliberate takeover**: the desktop user opened that terminal. Reclaiming is correct.
- **Incidental refit**: a bottom panel mounted, or a window resized. Nobody intended anything.

The phone would therefore be bumped at seemingly random moments, which is precisely the "the
user thinks it is a bug" failure this design exists to prevent. Only the registry knows intent,
so grid ownership and the arbiter ship together.

## Suggested phasing

1. **Mobile fallback hardening** (written, uncommitted): measured height fit plus short-grid
   centring. Zero desktop impact. Ships the floor.
2. **Resting-grid park** (written, uncommitted): fixes the nobody-holds-it case. Desktop-only,
   needs the Board -> Backlog -> Board regression check before landing.
3. **Column setting on mobile**: the user-facing control, useful before ownership lands.
4. **Terminal ownership**: widen `DetailHost` / `DetailOwner`, phone acquires and releases,
   desktop mirrored view plus Resume Control.

## Still open

- Grace-period duration on background (proposed ~10s, unconfirmed).
- Default column count and preset values, to be found by testing.
- Whether suppressing a desktop detail's terminal while keeping Changes and Chat is clean in
  the current component structure, or fights the one-xterm invariant's assumptions.
- Whether tapping the phone's existing `↑` quick key already scrolls history. If it does, the
  scroll diagnosis above is fully confirmed and the work is purely gesture wiring. Blocked on
  device access; the phone dropped off adb during the session.
- Whether drag-to-scroll should also apply in the NORMAL buffer (a non-fullscreen agent), where
  real scrollback exists and the same gesture should move xterm's viewport instead of sending
  arrows. xterm's own wheel handler already branches on `hasScrollback`, so synthesizing wheel
  events gets this right for free; sending arrows directly would not.
