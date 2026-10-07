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
  | 'autofillable-terminal-input';

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
