import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, TextInput } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeScanningResult, type BarcodeType } from 'expo-camera';
import { Screen, Stack, Text, Button, Card, useTheme } from '@/components';
import { validateScannedQr, type QrValidationErrorKind } from '@/pairing/qr';
import { beginPairing } from '@/pairing/activePairing';
import { DEMO_DEEP_LINK_PARAM, DEMO_PAIRING_SHORTCUT, isDemoPairingCode } from '@/demo/demoIdentity';
import { AlreadyPairedError, PairingInProgressError, beginDemoPairing } from '@/demo/demoPairing';

const ERROR_MESSAGES: Record<QrValidationErrorKind, string> = {
  'not-a-pairing-uri': 'That QR code is not a Kangentic pairing code.',
  malformed: 'That pairing code could not be read. Try scanning again.',
  expired: 'This pairing code has expired. Generate a new one on the desktop.',
  // Names neither side as the stale one: after a PROTOCOL_VERSION bump the phone is ahead of an
  // old desktop, but a phone that has not updated is behind a current one, and both land here.
  'version-incompatible': 'The desktop and this app are on incompatible versions. Update both and try again.',
  'insecure-relay': 'This pairing code points at an insecure relay. Kangentic requires a secure (wss://) connection.',
};

const UNEXPECTED_ERROR_MESSAGE = 'Could not start pairing. Try again.';

const SETTINGS_UNAVAILABLE_MESSAGE = 'Could not open Settings.';

/** Hoisted so the active CameraView is not handed a fresh settings object on every keystroke into the paste field. */
const BARCODE_SCANNER_SETTINGS: { barcodeTypes: BarcodeType[] } = { barcodeTypes: ['qr'] };

const PAIRING_DEVICE_NAME = 'Kangentic Mobile';

export function PairingScanScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const [permission, requestPermission, refreshCameraPermission] = useCameraPermissions();
  const [pastedLink, setPastedLink] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  // Synchronous re-entry latch. A useState guard is not visible same-tick, so
  // it let the camera's ~30fps barcode stream (or a double tap of the paste
  // submit) through together: two beginPairing dials into the same single-use
  // relay slot and two stacked confirm frames. Checked and set with no await
  // in between; isProcessing is its render-facing shadow (camera unwiring,
  // the paste submit's disabled state).
  const pairingInFlightRef = useRef(false);

  // The only writer of the latch pair. The ref and the state must move
  // together; a site that set one without the other would silently desync
  // the synchronous guard from what the UI shows.
  const setPairingInFlight = useCallback((inFlight: boolean) => {
    pairingInFlightRef.current = inFlight;
    setIsProcessing(inFlight);
  }, []);

  // Re-arm on focus regain. The latch deliberately survives the navigation to
  // /pair-confirm: this screen stays mounted beneath it, and releasing the
  // latch there would re-wire the camera so a stray barcode event could push
  // a second confirm frame. Coming back ("Go back" after a failed ceremony,
  // or a SAS reject) is the moment a rescan becomes legitimate again. The
  // initial-focus firing is a no-op, both values are already false.
  useFocusEffect(
    useCallback(() => {
      setPairingInFlight(false);
    }, [setPairingInFlight]),
  );

  const handleUri = useCallback(
    async (uri: string) => {
      if (pairingInFlightRef.current) return;
      setErrorMessage(null);
      // The reviewer/demo code, checked BEFORE any parsing and returning
      // unconditionally so it can never fall through into real pairing
      // validation. See isDemoPairingCode for why that ordering is load-bearing
      // rather than merely tidy. Both the camera and the paste field funnel
      // through here, so the QR, the typed code and the deep link all land on
      // this one branch.
      if (isDemoPairingCode(uri)) {
        setPairingInFlight(true);
        try {
          await beginDemoPairing(PAIRING_DEVICE_NAME);
        } catch (error: unknown) {
          // The refusals are not faults, and each needs to say which one it
          // is: "could not start pairing" on a phone that is working fine
          // reads as a broken app.
          setErrorMessage(
            error instanceof AlreadyPairedError || error instanceof PairingInProgressError ? error.message : UNEXPECTED_ERROR_MESSAGE,
          );
          setPairingInFlight(false);
          return;
        }
        router.navigate('/pair-confirm');
        return;
      }
      const result = validateScannedQr(uri);
      if (!result.ok) {
        // A rejected code must not latch: the user corrects and retries now.
        setErrorMessage(ERROR_MESSAGES[result.errorKind]);
        return;
      }
      setPairingInFlight(true);
      // Only beginPairing sits inside the try. If router.navigate threw with
      // the wider scope, the catch would report "could not start pairing"
      // after the ceremony had already dialed the single-use relay slot, and
      // releasing the latch would invite the second dial the latch exists to
      // prevent.
      try {
        await beginPairing(result.payload, PAIRING_DEVICE_NAME);
      } catch {
        // beginPairing can reject before the state machine exists (e.g. a
        // SecureStore failure loading the device identity); surface it here
        // rather than leaving an unhandled rejection with no user feedback.
        // No navigation happened, so no focus change will re-arm the screen:
        // release the latch here or it stays dead until remount.
        setErrorMessage(UNEXPECTED_ERROR_MESSAGE);
        setPairingInFlight(false);
        return;
      }
      // navigate, not push, as a dedupe seatbelt; not replace, which would
      // drop this screen from the stack and break the confirm screen's
      // "Go back"-to-rescan path.
      router.navigate('/pair-confirm');
    },
    [router, setPairingInFlight],
  );

  const handleBarcodeScanned = useCallback(
    (scanningResult: BarcodeScanningResult) => {
      void handleUri(scanningResult.data);
    },
    [handleUri],
  );

  // A demo deep link (kangentic-pair://demo) lands here as ?demo=1, set by
  // app/+native-intent.ts. Replay it through handleUri so the link takes the
  // identical path to a scan or a paste rather than a fourth entry point of its
  // own.
  //
  // Once per mount. The ref, not the effect deps, is the guard: useFocusEffect
  // above re-arms the in-flight latch every time this screen regains focus, so
  // coming back from a rejected confirm would otherwise immediately restart the
  // ceremony the user just backed out of.
  const demoDeepLinkHandledRef = useRef(false);
  const demoDeepLinkParam = useLocalSearchParams<{ demo?: string }>()[DEMO_DEEP_LINK_PARAM];
  useEffect(() => {
    if (demoDeepLinkParam !== '1' || demoDeepLinkHandledRef.current) return;
    demoDeepLinkHandledRef.current = true;
    void handleUri(DEMO_PAIRING_SHORTCUT);
  }, [demoDeepLinkParam, handleUri]);

  // useCameraPermissions reads the status once on mount and never again on its
  // own: its effect's deps are stable for the component's whole life, so only
  // an explicit call moves it. Without this, granting camera access in Settings
  // and coming back leaves `permission.granted` on the stale `false` from mount
  // and strands the user on the very screen that sent them to Settings.
  // 'active' is the moment a grant made outside the app becomes visible to it,
  // the same event SettingsScreen's notification notice listens on. Not
  // Android-only there, because both platforms reach Settings from this screen.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active') return;
      void refreshCameraPermission().catch(() => undefined);
    });
    return () => subscription.remove();
  }, [refreshCameraPermission]);

  const openAppSettings = useCallback(() => {
    // Clear first, like handleUri: a stale "Could not open Settings." left
    // under a retry that then succeeded would contradict the screen.
    setErrorMessage(null);
    // openSettings rejects when the OS declines to open the URL. There is
    // nothing to fall back to beyond the paste card already on screen, and an
    // uncaught rejection would be invisible in release, so say so rather than
    // leaving the tap looking ignored.
    void Linking.openSettings().catch(() => setErrorMessage(SETTINGS_UNAVAILABLE_MESSAGE));
  }, []);

  if (!permission) {
    return <Screen testID="pairing-scan-screen" />;
  }

  if (!permission.granted) {
    // Once the OS stops prompting, requestPermission() resolves without showing
    // anything, so a button wired to it renders normally and does nothing at
    // all - Settings is the only route back. canAskAgain is the signal that
    // separates "can still ask" from "asked and refused for good"; the two
    // platforms reach that state differently (iOS prompts once per install,
    // Android keeps allowing prompts until a permanent denial), which is why
    // this branches on the flag rather than on Platform.OS.
    const canPromptForCamera = permission.canAskAgain;
    return (
      <Screen testID="pairing-scan-screen">
        <Stack gap="lg" style={[styles.centered, { padding: theme.spacing.lg }]}>
          <Text variant="body" color="secondary">
            {canPromptForCamera
              ? 'Camera access is needed to scan a desktop pairing code.'
              : 'Turn on camera access in Settings to scan a code.'}
          </Text>
          {/* Neutral wording is required, not a style choice: App Review cited 5.1.1(iv) against
              "Grant camera access" on this exact screen (0.4.1 build 7, 2026-08-18). A custom
              pre-permission screen may explain, but its button must not push toward the OS prompt.
              The explainer above carries the reason; the button only advances. "Open Settings" is
              held to the same bar: it names where the tap goes, not an instruction to grant. */}
          <Button
            testID="pairing-request-camera-permission"
            label={canPromptForCamera ? 'Continue' : 'Open Settings'}
            onPress={canPromptForCamera ? () => void requestPermission() : openAppSettings}
          />
          <PasteLinkFallback pastedLink={pastedLink} setPastedLink={setPastedLink} onSubmit={handleUri} isSubmitInFlight={isProcessing} />
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
        <PasteLinkFallback pastedLink={pastedLink} setPastedLink={setPastedLink} onSubmit={handleUri} isSubmitInFlight={isProcessing} />
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
  /** Disables submit while a pairing attempt is in flight; the ref latch in handleUri is the actual re-entry guard. */
  isSubmitInFlight: boolean;
}

/** For camera-permission-denied users, and for Maestro E2E, which cannot drive a real camera. */
function PasteLinkFallback({ pastedLink, setPastedLink, onSubmit, isSubmitInFlight }: PasteLinkFallbackProps): React.JSX.Element {
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
        <Button
          testID="pairing-paste-link-submit"
          label="Pair"
          onPress={() => onSubmit(pastedLink)}
          disabled={pastedLink.length === 0 || isSubmitInFlight}
        />
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
