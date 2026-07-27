import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Screen, Stack, Text, Button, Overseer, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';
import { usePairingStore } from '@/state/pairingStore';
import { confirmActivePairing, rejectActivePairing } from '@/pairing/activePairing';
import { wipeDesktopContent } from '@/connection/actions';
import { reconnectNow } from '@/connection/connectionManager';

const CONNECTING_OVERSEER_SIZE = 72;
const SUCCESS_OVERSEER_SIZE = 90;
/** Wide enough to separate the digits for comparison without breaking them into two visual groups. */
const SAS_LETTER_SPACING = 6;

export function PairingConfirmScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const machineState = usePairingStore((state) => state.machineState);
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const successNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (successNavigationTimerRef.current !== null) {
        clearTimeout(successNavigationTimerRef.current);
      }
      // Leaving via back/swipe/tab-switch instead of Accept/Reject would
      // otherwise leave the module-level PairingMachine and its relay
      // WebSocket alive; tear it down unless the ceremony actually paired.
      if (usePairingStore.getState().machineState?.status !== 'paired') {
        rejectActivePairing();
      }
    };
  }, []);

  /**
   * The mismatch path. Rejecting tears the ceremony down and returns to the
   * scan screen; the pairing token is single-use, so the desktop must mint a
   * fresh QR either way.
   */
  const handleReject = (): void => {
    rejectActivePairing();
    triggerHaptic('destructiveConfirmed');
    router.back();
  };

  const handleAccept = async (): Promise<void> => {
    setIsConfirming(true);
    setConfirmError(null);
    try {
      await confirmActivePairing();
      triggerHaptic('pairingSucceeded');
      // A new pairing replaces the trust context: clear the previous
      // desktop's content before the fresh bootstrap repopulates.
      wipeDesktopContent();
      // Pick the freshly saved trust anchor up without an app restart.
      reconnectNow();
      // Let the success state's Overseer wave land before leaving; the store
      // is already 'paired', so the success branch below is what shows.
      const successHoldMs = theme.motion.overseer.waveDurationMs + theme.motion.durations.slow;
      successNavigationTimerRef.current = setTimeout(() => {
        successNavigationTimerRef.current = null;
        router.replace('/');
      }, successHoldMs);
    } catch {
      setConfirmError('Could not complete pairing. Try again, or reject and rescan.');
    } finally {
      setIsConfirming(false);
    }
  };

  if (!machineState || machineState.status === 'connecting' || machineState.status === 'handshaking') {
    return (
      <Screen testID="pairing-confirm-screen">
        <Stack gap="md" style={{ padding: theme.spacing.lg, flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Overseer size={CONNECTING_OVERSEER_SIZE} animate="blink-loop" testID="pairing-connecting-overseer" />
          <Text variant="body" color="secondary">
            Connecting to the desktop...
          </Text>
        </Stack>
      </Screen>
    );
  }

  if (machineState.status === 'error') {
    return (
      <Screen testID="pairing-confirm-screen">
        <Stack gap="md" style={{ padding: theme.spacing.lg, flex: 1, justifyContent: 'center' }}>
          <Text variant="body" color="danger">
            {machineState.message}
          </Text>
          <Button testID="pairing-confirm-back" label="Go back" onPress={() => router.back()} />
        </Stack>
      </Screen>
    );
  }

  // Matched on 'paired' alone, never as the fall-through for every status that
  // is not 'awaiting-sas'. Cancel sets the machine to 'rejected' and this
  // screen stays mounted for the whole pop transition, so a fall-through
  // success branch renders "Pairing complete." at the user who just rejected a
  // mismatched code - the one answer the app's only defence against a
  // relay-in-the-middle must never give.
  if (machineState.status === 'paired') {
    return (
      <Screen testID="pairing-confirm-screen">
        <Stack gap="md" style={{ padding: theme.spacing.lg, flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Overseer size={SUCCESS_OVERSEER_SIZE} animate="wave-once" testID="pairing-success-overseer" />
          <Text variant="body" color="secondary">
            Pairing complete.
          </Text>
        </Stack>
      </Screen>
    );
  }

  // Rejected: the ceremony is torn down and the caller is already navigating
  // away. Hold the neutral connecting state for the transition rather than
  // claiming any outcome.
  if (machineState.status !== 'awaiting-sas') {
    return (
      <Screen testID="pairing-confirm-screen">
        <Stack gap="md" style={{ padding: theme.spacing.lg, flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Overseer size={CONNECTING_OVERSEER_SIZE} animate="blink-loop" testID="pairing-connecting-overseer" />
        </Stack>
      </Screen>
    );
  }

  const { sas } = machineState;

  // The digits ARE the SAS; the emoji row rendered the same transcript hash
  // a second way, adding a wrapping row and cross-platform font risk without
  // adding assurance. One code, compared once.
  return (
    <Screen testID="pairing-confirm-screen">
      <Stack gap="lg" style={{ padding: theme.spacing.lg, flex: 1, justifyContent: 'center' }}>
        <Text variant="body" color="secondary">
          Confirm this matches your desktop
        </Text>
        {/* The digits are the whole point of the screen, so they carry the
            hierarchy: display size, and MONOSPACE with wide tracking because
            this is a character-by-character comparison against another
            screen, where proportional digits make the reader work harder. */}
        <Text
          testID="sas-digits"
          variant="display"
          style={{ fontFamily: theme.fontFamilyMono, letterSpacing: SAS_LETTER_SPACING }}
        >
          {sas.digits}
        </Text>
        {/* Two explicit actions. A mismatch is the one thing this screen
            exists to catch - an active relay-in-the-middle - so rejecting it
            must be a deliberate button, not a back-swipe the user has to
            infer is safe. Cancel is ghost so Confirm stays the primary path
            for the overwhelmingly common case where the codes DO match. */}
        <Button testID="sas-accept" label="Confirm" onPress={() => void handleAccept()} disabled={isConfirming} />
        <Button testID="sas-reject" label="Cancel" variant="ghost" onPress={handleReject} disabled={isConfirming} />
        {confirmError ? (
          <Text testID="sas-confirm-error" variant="caption" color="danger">
            {confirmError}
          </Text>
        ) : null}
      </Stack>
    </Screen>
  );
}
