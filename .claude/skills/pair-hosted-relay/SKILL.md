---
name: pair-hosted-relay
description: >-
  Connect the phone to the desktop through the KANGENTIC-HOSTED relay
  (wss://relay.kangentic.com) rather than the local dev relay, and prove it.
  Use for "connect my pixel to desktop using the hosted relay", "test against
  the live relay", or any request to exercise the real wss:// path. This is a
  different setup from `dev:live`, not a flag on it.
---

# Pair the phone through the hosted relay

`dev:live` means "your real desktop rather than the stub peer". It does NOT
mean a live relay - it runs `ws://127.0.0.1:8080` over a USB `adb reverse`.
The hosted path is genuinely different, and the difference is the point: it is
the only setup that exercises `wss://`, real network latency, and the
relay-address rules in `src/pairing/qr.ts` that the loopback carve-out
bypasses.

Addresses, from `kangentic/src/shared/relay.ts` (do not hardcode elsewhere):
- hosted: `wss://relay.kangentic.com` (`KANGENTIC_HOSTED_RELAY_URL`)
- local dev: `ws://127.0.0.1:8080` (`LOCAL_DEV_RELAY_URL`)

## The two facts that make a hosted attempt fail confusingly

1. **The QR carries the relay address**, and the DESKTOP mints the QR. A
   desktop still on `relayMode: 'local'` pairs the phone to loopback no matter
   what the mobile rig was told. Switch the desktop FIRST.
2. **The address is baked into the trust anchor at pairing time.** An existing
   pairing cannot be redirected - it must be re-paired. A phone that "still
   shows 127.0.0.1" after a switch is not a bug.

## Steps

### 1. Confirm the phone is attached

```
adb devices -l
```
Take its serial. If only an emulator is listed, stop and say so - the hosted
path is being tested on a real device for a reason.

### 2. Point the desktop at the hosted relay

Read the current mode: `%APPDATA%\Kangentic\config.json` ->
`mobileBridge.relayMode` (`hosted` | `local` | `custom`; absent means hosted).

**Prefer the app's own UI** - Settings > Mobile Devices - so the desktop
applies the change through `resolveRelayUrl` and reconnects itself. Ask the
user to flip it and confirm. Editing `config.json` under a running app risks
being overwritten on its next write, and needs a restart to take effect.

### 3. Bring up the mobile rig against the hosted relay

```
npm run dev:pair -- --serial <serial> --relay wss://relay.kangentic.com
```

`--relay` starts nothing locally and skips the 8080 reverse - the phone dials
a public host over the network, so USB carries only Metro. `dev:pair` clears
the app to unpaired, which is required by fact 2 above.

A remote `ws://` is refused by the rig with the reason: the pairing token is
the Noise PSK and is dialed verbatim as the relay slot, so plaintext
off-loopback is never acceptable.

### 4. Pair through the real ceremony

Desktop: Settings > Mobile Devices > Pair a device. Scan the QR with the phone
(or paste the link). Confirm the SAS on both sides.

### 5. PROVE it - do not assume

```
node scripts/mobileInspect.mjs state connection --serial <serial>
```

`relayUrl` must read `wss://relay.kangentic.com`. If it still reads
`ws://127.0.0.1:8080`, the desktop was not switched before minting the QR
(fact 1) or the old pairing survived (fact 2).

Cross-check visually: the app's Settings > Connection shows the live relay
URL under a "Relay" caption (`testID="settings-relay-url"`).

## Afterwards

The phone stays paired to the hosted relay until re-paired. To return to the
local rig, switch the desktop back and re-pair - the same two facts apply in
reverse.

Report which relay `relayUrl` actually shows, not which one was requested.
