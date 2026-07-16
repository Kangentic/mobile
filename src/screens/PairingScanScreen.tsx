import React, { useCallback, useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import { useRouter } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeScanningResult, type BarcodeType } from 'expo-camera';
import { Screen, Stack, Text, Button, Card, useTheme } from '@/components';
import { validateScannedQr, type QrValidationErrorKind } from '@/pairing/qr';
import { beginPairing } from '@/pairing/activePairing';

const ERROR_MESSAGES: Record<QrValidationErrorKind, string> = {
  'not-a-pairing-uri': 'That QR code is not a Kangentic pairing code.',
  malformed: 'That pairing code could not be read. Try scanning again.',
  expired: 'This pairing code has expired. Generate a new one on the desktop.',
  'version-incompatible': 'This desktop is running an incompatible version. Update it and try again.',
  'insecure-relay': 'This pairing code points at an insecure relay. Kangentic requires a secure (wss://) connection.',
};

const UNEXPECTED_ERROR_MESSAGE = 'Could not start pairing. Try again.';

/** Hoisted so the active CameraView is not handed a fresh settings object on every keystroke into the paste field. */
const BARCODE_SCANNER_SETTINGS: { barcodeTypes: BarcodeType[] } = { barcodeTypes: ['qr'] };

const PAIRING_DEVICE_NAME = 'Kangentic Mobile';

export function PairingScanScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [pastedLink, setPastedLink] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleUri = useCallback(
    async (uri: string) => {
      if (isProcessing) return;
      setErrorMessage(null);
      const result = validateScannedQr(uri);
      if (!result.ok) {
        setErrorMessage(ERROR_MESSAGES[result.errorKind]);
        return;
      }
      setIsProcessing(true);
      try {
        await beginPairing(result.payload, PAIRING_DEVICE_NAME);
        router.push('/pair-confirm');
      } catch {
        // beginPairing can reject before the state machine exists (e.g. a
        // SecureStore failure loading the device identity); surface it here
        // rather than leaving an unhandled rejection with no user feedback.
        setErrorMessage(UNEXPECTED_ERROR_MESSAGE);
      } finally {
        setIsProcessing(false);
      }
    },
    [isProcessing, router],
  );

  const handleBarcodeScanned = useCallback(
    (scanningResult: BarcodeScanningResult) => {
      void handleUri(scanningResult.data);
    },
    [handleUri],
  );

  if (!permission) {
    return <Screen testID="pairing-scan-screen" />;
  }

  if (!permission.granted) {
    return (
      <Screen testID="pairing-scan-screen">
        <Stack gap="lg" style={[styles.centered, { padding: theme.spacing.lg }]}>
          <Text variant="body" color="secondary">
            Camera access is needed to scan a desktop pairing code.
          </Text>
          <Button testID="pairing-request-camera-permission" label="Grant camera access" onPress={() => void requestPermission()} />
          <PasteLinkFallback pastedLink={pastedLink} setPastedLink={setPastedLink} onSubmit={handleUri} />
          {errorMessage ? (
            <Text testID="pairing-scan-error" variant="caption" color="danger">
              {errorMessage}
            </Text>
          ) : null}
        </Stack>
      </Screen>
    );
  }

  return (
    <Screen testID="pairing-scan-screen">
      <CameraView
        testID="pairing-scanner"
        style={styles.camera}
        barcodeScannerSettings={BARCODE_SCANNER_SETTINGS}
        onBarcodeScanned={isProcessing ? undefined : handleBarcodeScanned}
      />
      <Stack gap="sm" style={{ padding: theme.spacing.lg }}>
        <PasteLinkFallback pastedLink={pastedLink} setPastedLink={setPastedLink} onSubmit={handleUri} />
        {errorMessage ? (
          <Text testID="pairing-scan-error" variant="caption" color="danger">
            {errorMessage}
          </Text>
        ) : null}
      </Stack>
    </Screen>
  );
}

interface PasteLinkFallbackProps {
  pastedLink: string;
  setPastedLink: (value: string) => void;
  onSubmit: (uri: string) => void;
}

/** For camera-permission-denied users, and for Maestro E2E, which cannot drive a real camera. */
function PasteLinkFallback({ pastedLink, setPastedLink, onSubmit }: PasteLinkFallbackProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card>
      <Stack gap="sm">
        <Text variant="caption" color="secondary">
          Or paste a pairing link
        </Text>
        <TextInput
          testID="pairing-paste-link-input"
          value={pastedLink}
          onChangeText={setPastedLink}
          placeholder="kangentic-pair://..."
          placeholderTextColor={theme.colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardAppearance="dark"
          style={{
            color: theme.colors.textPrimary,
            backgroundColor: theme.colors.surfaceRaised,
            borderColor: theme.colors.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: theme.radii.sm,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: theme.spacing.sm,
            fontSize: theme.typography.body.fontSize,
          }}
        />
        <Button testID="pairing-paste-link-submit" label="Pair" onPress={() => onSubmit(pastedLink)} disabled={pastedLink.length === 0} />
      </Stack>
    </Card>
  );
}

const styles = StyleSheet.create({
  camera: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
  },
});
