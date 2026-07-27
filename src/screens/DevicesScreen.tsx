import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, MonoText, Row, Screen, Stack, StatusDot, Text, useTheme } from '@/components';
import { wipeDesktopContent } from '@/connection/actions';
import { reconnectNow, revokePushRegistrationForUnpair } from '@/connection/connectionManager';
import { TrustAnchorStore } from '@/pairing/trustAnchor';
import { useChannelStore } from '@/state/channelStore';
import { formatKeyFingerprint, usePairedDesktopInfo } from './usePairedDesktopInfo';

const trustAnchorStore = new TrustAnchorStore();

/**
 * The paired-desktop overview: what this phone trusts, how it is connected,
 * and the one local control the protocol gives it (unpairing = clearing the
 * trust anchor; revoking a PHONE's access is a desktop-side action, and the
 * screen says so instead of pretending).
 */
export function DevicesScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const pairedInfo = usePairedDesktopInfo();
  const transportState = useChannelStore((state) => state.transportState);
  const established = useChannelStore((state) => state.established);
  const relayUrl = useChannelStore((state) => state.relayUrl);
  const [unpairArmed, setUnpairArmed] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [unpairError, setUnpairError] = useState<string | null>(null);

  /**
   * Two-step confirm with no clock on it, for the same reason the task sheet's
   * delete has none: an armed destructive control that relaxes on a timer
   * relaxes SILENTLY, so a confirm tap arriving late is reinterpreted as a
   * fresh arm and the user sees the button they just pressed, unchanged and
   * unexplained. This one was worse - five seconds to read "Tap again to
   * confirm" and decide whether to drop the pairing. The second tap is the
   * guard; the clock never was.
   */
  const onUnpairPress = useCallback(() => {
    if (!unpairArmed) {
      setUnpairArmed(true);
      return;
    }
    setUnpairArmed(false);
    setUnpairing(true);
    setUnpairError(null);
    void revokePushRegistrationForUnpair()
      .then(() => trustAnchorStore.clear())
      .then(() => {
        // Revoking trust also revokes what was fetched under it: every
        // store and cache holding the desktop's content is cleared so
        // nothing readable outlives the pairing on an unlocked phone.
        wipeDesktopContent();
        reconnectNow();
        router.back();
      })
      // Unpair had no failure path at all: a rejected revoke or a Keychain
      // write that threw left the phone still paired, the button back to
      // "Unpair", and nothing said so. Say so.
      .catch((error: unknown) =>
        setUnpairError(error instanceof Error ? error.message : 'Unpair failed - try again'),
      )
      .finally(() => setUnpairing(false));
  }, [unpairArmed, router]);

  const connectionLabel = established ? 'Connected' : transportState === 'idle' ? 'Not connected' : transportState;

  return (
    <Screen testID="devices-screen">
      <Stack gap="md" style={{ padding: theme.spacing.lg }}>
        {/* The native stack header already titles this screen. */}
        {pairedInfo.status === 'loading' ? (
          <Text variant="body" color="secondary">
            Loading...
          </Text>
        ) : pairedInfo.status === 'unpaired' ? (
          <Stack gap="sm">
            <Text variant="body" color="secondary">
              No desktop paired yet.
            </Text>
            <Button label="Pair" onPress={() => router.push('/pair')} testID="devices-pair-cta" />
          </Stack>
        ) : (
          <>
            <Card testID="devices-desktop-card">
              <Stack gap="xs">
                <Row gap="sm" style={styles.spaceBetween}>
                  <Text variant="bodyStrong">Your desktop</Text>
                  <Row gap="xs" style={styles.statusRow}>
                    <StatusDot variant={established ? 'working' : 'idle'} testID="devices-connection-dot" />
                    <Text variant="caption" color={established ? 'success' : 'secondary'}>
                      {connectionLabel}
                    </Text>
                  </Row>
                </Row>
                <LabeledValue label="Key fingerprint">
                  <MonoText size="caption" testID="devices-desktop-fingerprint">
                    {formatKeyFingerprint(pairedInfo.info.desktopPublicKeyHex)}
                  </MonoText>
                </LabeledValue>
                <LabeledValue label="Relay">
                  <MonoText size="caption" numberOfLines={1}>
                    {pairedInfo.info.relayAddress}
                  </MonoText>
                </LabeledValue>
                <LabeledValue label="Paired">
                  <Text variant="caption" color="secondary">
                    {new Date(pairedInfo.info.pairedAt).toLocaleString()}
                  </Text>
                </LabeledValue>
              </Stack>
            </Card>

            <Card testID="devices-phone-card">
              <Stack gap="xs">
                <Text variant="bodyStrong">This phone</Text>
                {/* It is the phone's static public key, shortened - not an
                    id the desktop assigned. Naming it honestly is what lets
                    a user compare it against the desktop's device list. */}
                <LabeledValue label="Key fingerprint">
                  <MonoText size="caption" testID="devices-phone-fingerprint">
                    {formatKeyFingerprint(pairedInfo.info.phonePublicKeyHex)}
                  </MonoText>
                </LabeledValue>
              </Stack>
            </Card>

            {/* Unpair is the ONLY control here on purpose. This phone holds
                one desktop trust anchor, so a "pair a different desktop"
                button was a second route to the same place with different
                words: it unpairs first either way. Two buttons invited the
                user to work out which one they wanted; one button plus the
                cards above says the true thing - this phone is paired to that
                desktop, and unpairing is how you start over. */}
            <Button
              label={unpairing ? 'Unpairing...' : unpairArmed ? 'Tap again to confirm' : 'Unpair'}
              variant="danger"
              onPress={onUnpairPress}
              disabled={unpairing}
              testID={unpairArmed ? 'devices-unpair-confirm' : 'devices-unpair'}
            />
            {unpairError ? (
              <Text variant="caption" color="danger" style={styles.centered} testID="devices-unpair-error">
                {unpairError}
              </Text>
            ) : null}
          </>
        )}

        {relayUrl && pairedInfo.status !== 'paired' ? (
          <LabeledValue label="Active relay">
            <MonoText size="caption" numberOfLines={1}>
              {relayUrl}
            </MonoText>
          </LabeledValue>
        ) : null}
      </Stack>
    </Screen>
  );
}

function LabeledValue({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View>
      <Text variant="caption" color="muted">
        {label}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
  spaceBetween: {
    justifyContent: 'space-between',
  },
  statusRow: {
    alignItems: 'center',
  },
});
