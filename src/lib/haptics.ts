import * as Haptics from 'expo-haptics';
import { useSettingsStore } from '@/state/settingsStore';

/**
 * The closed vocabulary of haptic cues. Every meaningful action maps to one
 * of these names so the physical feedback stays consistent app-wide:
 * - `promptAnswered` - a permission prompt or question was answered.
 * - `taskMoved` / `taskCreated` - a board write landed.
 * - `pairingSucceeded` - the pairing ceremony completed.
 * - `modeToggled` - a segmented/mode control changed selection.
 * - `destructiveConfirmed` - a destructive action (reject, delete) was confirmed.
 */
export type HapticCue =
  | 'promptAnswered'
  | 'taskMoved'
  | 'taskCreated'
  | 'pairingSucceeded'
  | 'modeToggled'
  | 'destructiveConfirmed';

function hapticEffectForCue(cue: HapticCue): Promise<void> {
  switch (cue) {
    case 'promptAnswered':
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    case 'taskMoved':
    case 'taskCreated':
    case 'pairingSucceeded':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    case 'modeToggled':
      return Haptics.selectionAsync();
    case 'destructiveConfirmed':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }
}

/**
 * Fire-and-forget haptic feedback, gated on the user's haptics setting.
 * Failures are swallowed: a missing vibrator (emulator, some tablets) must
 * never break the action that triggered the cue. In dev builds every fired
 * cue is logged so emulator runs (which have no vibration motor to feel)
 * can still verify the wiring.
 */
export function triggerHaptic(cue: HapticCue): void {
  if (!useSettingsStore.getState().hapticsEnabled) return;
  if (__DEV__) {
    console.log(`[haptics] ${cue}`);
  }
  void hapticEffectForCue(cue).catch(() => undefined);
}

/**
 * Hook form for components that prefer an injected trigger (and for future
 * per-screen gating). Returns the module-level trigger, which is already
 * stable across renders.
 */
export function useHaptics(): (cue: HapticCue) => void {
  return triggerHaptic;
}
