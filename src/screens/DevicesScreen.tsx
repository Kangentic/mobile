import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Card, MonoText, Row, Screen, Stack, StatusDot, Text, useTheme } from '@/components';
import { reconnectNow } from '@/connection/connectionManager';
import { TrustAnchorStore } from '@/pairing/trustAnchor';
import { useChannelStore } from '@/state/channelStore';
import { formatKeyFingerprint, usePairedDesktopInfo } from './usePairedDesktopInfo';

const trustAnchorStore = new TrustAnchorStore();

/** How long the armed unpair confirmation stays armed before it relaxes back. */
const UNPAIR_CONFIRM_WINDOW_MS = 5000;

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

  useEffect(() => {
    if (!unpairArmed) return;
    const disarmTimer = setTimeout(() => setUnpairArmed(false), UNPAIR_CONFIRM_WINDOW_MS);
    return () => clearTimeout(disarmTimer);
  }, [unpairArmed]);

  const onUnpairPress = useCallback(() => {
    if (!unpairArmed) {
      setUnpairArmed(true);
      return;
    }
    setUnpairing(true);
    void trustAnchorStore
      .clear()
      .then(() => {
        reconnectNow();
        router.back();
      })
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
              No desktop is paired on this phone yet (dev-rig connections bypass pairing and do not
              appear here).
            </Text>
            <Button label="Pair with your desktop" onPress={() => router.push('/pair')} testID="devices-pair-cta" />
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
                <LabeledValue label="Device id">
                  <MonoText size="caption" testID="devices-phone-fingerprint">
                    {formatKeyFingerprint(pairedInfo.info.phonePublicKeyHex)}
                  </MonoText>
                </LabeledValue>
              </Stack>
            </Card>

            {/* This phone holds ONE desktop trust anchor: pairing again is
                a REPLACEMENT, so it sits here with unpair and says so. */}
            <Stack gap="xs">
              <Button
                label="Pair a different desktop"
                variant="ghost"
                onPress={() => router.push('/pair')}
                testID="devices-pair-different"
              />
              <Text variant="caption" color="muted" style={styles.centered}>
                Replaces the pairing on this phone
              </Text>
            </Stack>

            <Button
              label={unpairing ? 'Unpairing...' : unpairArmed ? 'Tap again to unpair' : 'Unpair this desktop'}
              variant="danger"
              onPress={onUnpairPress}
              disabled={unpairing}
              testID={unpairArmed ? 'devices-unpair-confirm' : 'devices-unpair'}
            />
          </>
        )}

        <Text variant="caption" color="muted">
          {"To revoke a phone's access to your desktop, remove it in the desktop app's Mobile Devices settings; the desktop's signed device roster is the authority."}
        </Text>
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
