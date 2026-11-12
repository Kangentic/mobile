import { useSyncExternalStore } from 'react';

/**
 * A RUNTIME switch for bisecting native view retention on the session screen.
 *
 * Retention has to be measured on a release build (`dumpsys meminfo`'s Objects
 * block, after a forced GC), and a release build embeds its JS bundle - so the
 * obvious way to bisect, editing a component and rebuilding, costs one full
 * APK per hypothesis. Worse, each build is a different install against
 * different session content, which is exactly the confound that made the first
 * ChatPane bisect compare a variant on a real desktop against a control from
 * the demo.
 *
 * This collapses both problems: one build carries every variant, they are
 * chosen from Settings at runtime, and the control is the same install with
 * the same content. Retention is additive, so a variant is measured as a
 * DELTA over a fresh GC-forced baseline taken immediately before its cycles -
 * views retained by an earlier variant are a constant offset, not an error.
 *
 * Gated exactly like the crash-reporting test rig: `EXPO_PUBLIC_*` is inlined
 * at bundle time, so this is inert (and dead-code-eliminated) in every build
 * that was not dispatched with the flag on. Never on in a store build.
 */
export type RetentionProbeVariant =
  | 'off'
  | 'no-conversation'
  | 'plain-cells'
  | 'plain-markdown'
  | 'markdown-not-selectable'
  | 'single-markdown'
  | 'markdown-empty'
  | 'no-motion'
  | 'extra-mappers'
  | 'no-swap-veil'
  | 'composer-no-dictation'
  | 'measured-fit'
  | 'autofillable-terminal-input'
  | 'description-commonmark'
  | 'no-terminal-links'
  | 'rebuilt-link-overlay';

export const RETENTION_PROBE_VARIANTS: {
  variant: RetentionProbeVariant;
  label: string;
  description: string;
}[] = [
  { variant: 'off', label: 'Off (control)', description: 'The app as shipped' },
  { variant: 'no-conversation', label: 'No conversation feed', description: 'ChatPane renders nothing' },
  { variant: 'plain-cells', label: 'Plain cells', description: 'Every transcript cell is one Text' },
  { variant: 'plain-markdown', label: 'Plain markdown', description: 'Markdown cells drop the native view' },
  {
    variant: 'markdown-not-selectable',
    label: 'Markdown not selectable',
    description: 'Keeps the native view, drops selection',
  },
  {
    variant: 'single-markdown',
    label: 'One markdown, no list',
    description: 'ChatPane is one markdown block',
  },
  {
    variant: 'markdown-empty',
    label: 'One markdown, no content',
    description: 'The view exists but never renders',
  },
  {
    variant: 'no-motion',
    label: 'No looping motion',
    description: 'Closes the gate on a focused screen too',
  },
  {
    variant: 'extra-mappers',
    label: 'Extra idle mappers',
    description: 'Mounts N clean animated mappers per feed row',
  },
  {
    // The arm the swap-veil investigation lacked: a DEAD session's terminal
    // pane drawn bare with no veil over it, so what the WebView does after
    // the PTY dies is measured on its own (2026-09-18: 18 frames in 45 s,
    // nothing) rather than inferred from a veil that turned out not to be
    // static. Pair it with 'no-motion' for the veil held genuinely still.
    variant: 'no-swap-veil',
    label: 'No swap veil',
    description: 'A dead terminal stays bare',
  },
  {
    // Isolates expo-modules-core #50603 (fixed in 57.0.21): a subscription's
    // remove() kept the emitter and the listener alive as GC roots. The
    // composer's four `useSpeechRecognitionEvent` listeners are that exact
    // shape (expo's `useEventListener`), and one composer mounts per session
    // open. Measured as the open/close retention gap between this arm and
    // 'off' in ONE build: a gap on 57.0.20 that closes on 57.0.21 ties the
    // win to that fix rather than to the dependency refresh as a whole.
    variant: 'composer-no-dictation',
    label: 'Composer without dictation',
    description: 'No speech listeners are registered',
  },
  {
    // The control arm of the black-terminal fix (scripts/xterm-page/cellFit.js):
    // the older fit that stretches the line height a frame at a time, resizing
    // and clearing the WebGL canvas on every pass. Read the `terminal-fit`
    // trace's cellWrites and chainMs for each arm, on the fit button, in one
    // build. Takes effect from the next terminal init (reopen the session).
    variant: 'measured-fit',
    label: 'Old terminal fit',
    description: 'Multi-pass fit, one canvas resize per pass',
  },
  {
    // The control arm of the terminal autofill fix: the page stops cancelling
    // the long-press `contextmenu`, so a long-press on the terminal raises
    // Android's text menu over xterm's hidden textarea, which offers only
    // "Autofill" when an autofill service is set. Long-press the cursor in
    // each arm and screenshot. Takes effect from the next terminal init.
    variant: 'autofillable-terminal-input',
    label: 'Terminal long-press menu',
    description: 'Long-press shows the Autofill menu',
  },
  {
    // The control arm of the completed task Description's GitHub flavor
    // (task #130): the library's container-based renderer, which draws task
    // list checkboxes, against the single-TextView CommonMark renderer every
    // other surface uses. Open and close a completed task's Description in
    // each arm and compare the GC-forced Views count and the frame read.
    variant: 'description-commonmark',
    label: 'Description as CommonMark',
    description: 'No GitHub flavor on a completed task',
  },
  {
    // The control arm of tappable terminal links (task #144,
    // scripts/xterm-page/links.js): the page neither scans the screen for
    // links on each render nor underlines them, and a tap is a plain tap.
    // Read idle and streaming CPU with frames over the same window in each
    // arm. A streaming arm with links on screen comes from the mock's
    // `/link-stream still|scroll` command (task #147), and a release build
    // reads the scan's cost from the `terminal-link-stats` line, which needs
    // the connection trace compiled in too. Takes effect from the next
    // terminal init.
    variant: 'no-terminal-links',
    label: 'No terminal links',
    description: 'No link scan, underline or tap',
  },
  {
    // The control arm of the underline slots (task #147,
    // scripts/xterm-page/links.js): the overlay as it first shipped, every
    // underline element thrown away and made again whenever a link changed.
    // A scrolling stream with links on screen (`/link-stream scroll`) moves
    // every link on every write, and that rebuild was measured holding the
    // WebView's GPU thread, in the app process, at 15-19% of a core against
    // 2-4% without links (docs/architecture.md: a release build on the
    // kangentic_profile emulator, whose GPU work is translated to the host's,
    // one diagnostic thread sample of 6 readings per arm). Read app and renderer CPU
    // with frames against the shipped slots and against `no-terminal-links`.
    // Takes effect from the next terminal init.
    variant: 'rebuilt-link-overlay',
    label: 'Old link underlines',
    description: 'Rebuilt on every change',
  },
];

const probeEnabled = process.env.EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE === '1';

let activeVariant: RetentionProbeVariant = 'off';
const listeners = new Set<() => void>();

/** True only in a build dispatched with the probe flag on. */
export function retentionProbeEnabled(): boolean {
  return probeEnabled;
}

/**
 * Read at render time by each bisect site. Always 'off' when the probe is not
 * compiled in, so every call site collapses to the shipped branch.
 */
export function getRetentionProbeVariant(): RetentionProbeVariant {
  return probeEnabled ? activeVariant : 'off';
}

export function setRetentionProbeVariant(variant: RetentionProbeVariant): void {
  if (!probeEnabled || activeVariant === variant) return;
  activeVariant = variant;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes the Settings control to the active variant. */
export function useRetentionProbeVariant(): RetentionProbeVariant {
  return useSyncExternalStore(subscribe, getRetentionProbeVariant, getRetentionProbeVariant);
}
