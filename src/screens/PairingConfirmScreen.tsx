import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { Screen, Stack, Row, Text, Button, Overseer, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';
import { usePairingStore } from '@/state/pairingStore';
import { confirmActivePairing, rejectActivePairing, resetActivePairing } from '@/pairing/activePairing';
import { reconnectNow } from '@/connection/connectionManager';

const CONNECTING_OVERSEER_SIZE = 72;
const SUCCESS_OVERSEER_SIZE = 90;

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

  const handleAccept = async (): Promise<void> => {
    setIsConfirming(true);
    setConfirmError(null);
    try {
      await confirmActivePairing();
      triggerHaptic('pairingSucceeded');
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

  const handleReject = (): void => {
    triggerHaptic('destructiveConfirmed');
    rejectActivePairing();
    resetActivePairing();
    router.back();
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

  if (machineState.status !== 'awaiting-sas') {
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

  const { sas } = machineState;

  return (
    <Screen testID="pairing-confirm-screen">
      <Stack gap="lg" style={{ padding: theme.spacing.lg, flex: 1, justifyContent: 'center' }}>
        <Text variant="title">Confirm this matches your desktop</Text>
        <Text variant="body" color="secondary">
          These must match the code shown on your desktop. If they do not match, reject and pair again.
        </Text>
        <Text testID="sas-digits" variant="heading">
          {sas.digits}
        </Text>
        <Row gap="sm" testID="sas-emoji" style={{ flexWrap: 'wrap' }}>
          {sas.emoji.map((glyph, index) => (
            <Text key={`${glyph}-${index}`} variant="heading">
              {glyph}
            </Text>
          ))}
        </Row>
        <Row gap="md">
          <Button testID="sas-reject" label="Reject" variant="danger" onPress={handleReject} />
          <Button testID="sas-accept" label="Accept" onPress={() => void handleAccept()} disabled={isConfirming} />
        </Row>
        {confirmError ? (
          <Text testID="sas-confirm-error" variant="caption" color="danger">
            {confirmError}
          </Text>
        ) : null}
      </Stack>
    </Screen>
  );
}
