# App Review assets

Attachments for the App Store Connect / Play Console **App Review Information** section. Not
listing images (those live in `store/screenshots/`) and never shown to users.

## `demo-pairing-qr.png` / `.svg`

The permanent reviewer/demo pairing code, as a scannable QR.

**Why it exists.** Kangentic Mobile pairs by scanning a QR the desktop app generates, and every
real pairing code is single-use and expires within minutes, because the code is a one-time token
mixed into the Noise handshake as a pre-shared key. A code in a screenshot or a video is therefore
always dead by the time a reviewer opens it. iOS App Review hit exactly that three times on
Guideline 2.1(a) with 0.5.1 (build 9), having genuinely tried the code in an attached recording.
This QR never expires, needs no desktop, and needs no network.

**What it encodes.** A genuine, correctly formatted `kangentic-pair://<base64url>` pairing URI, so
it is indistinguishable in shape from a real one.

Three forms are accepted, all matched as exact strings before any parsing:

| Form | Purpose |
|---|---|
| `demo` | What the review notes tell a reviewer to TYPE. Shortest, and the field's `kangentic-pair://...` placeholder is only a hint, not a required format. |
| `kangentic-pair://demo` | The deep link, so a tappable link in an email or the notes launches straight into it. |
| the full encoded URI above | What this QR encodes, so the image is shaped exactly like a real pairing QR. |

A bare `demo` cannot collide with a real code, because every real pairing URI begins with
`kangentic-pair://`.

**Regenerating.** `node scripts/buildDemoPairingQr.mjs`. It VERIFIES by default: it re-derives the
URI independently and refuses to write anything if the result disagrees with the frozen
`DEMO_PAIRING_URI` literal in `src/demo/demoIdentity.ts`. That disagreement means a derivation
label changed, which would silently break any QR already in a reviewer's hands. `--rotate` mints a
genuinely new code and prints the literal to paste; only do that if the code is being deliberately
retired, and reissue the image everywhere it has been sent.

A protocol-version bump does NOT require regenerating: the version rides inside the blob but is
never read back, because the demo is matched as an exact string and never decoded or validated.

**The reviewer-facing wording to paste into App Review Notes** lives in
[`docs/store-listing.md`](../../docs/store-listing.md), under "Notes for reviewers / app access".
Keep the two in step: the QR is useless to a reviewer who has not been told what it does.
