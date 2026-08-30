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
  | 'no-motion';

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
