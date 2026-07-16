import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Icon, MonoText, Row, Screen, Stack, StatusDot, Text, useTheme } from '@/components';
import { useChannelStore } from '@/state/channelStore';
import {
  useSettingsStore,
  type BackgroundNotificationsMode,
  type DictationMode,
} from '@/state/settingsStore';

const DICTATION_OPTIONS: { mode: DictationMode; label: string; description: string; testID: string }[] = [
  {
    mode: 'auto-send',
    label: 'Auto-send',
    description: 'Send dictated text as soon as you finish speaking',
    testID: 'settings-dictation-auto-send',
  },
  {
    mode: 'manual-send',
    label: 'Review before sending',
    description: 'Dictation fills the composer; you tap send',
    testID: 'settings-dictation-manual-send',
  },
  {
    mode: 'off',
    label: 'Off',
    description: 'Hide the microphone button',
    testID: 'settings-dictation-off',
  },
];

const NOTIFICATION_MODE_OPTIONS: {
  mode: BackgroundNotificationsMode;
  label: string;
  description: string;
  testID: string;
}[] = [
  {
    mode: 'foreground-service',
    label: 'Stay connected',
    description: 'Keeps the secure channel alive in the background for instant alerts (a quiet ongoing notification anchors it)',
    testID: 'settings-notifications-foreground-service',
  },
  {
    mode: 'push-only',
    label: 'Push only',
    description: 'Disconnects in the background; encrypted push wakes the app when an agent needs you',
    testID: 'settings-notifications-push-only',
  },
  {
    mode: 'off',
    label: 'Off',
    description: 'No background alerts of any kind',
    testID: 'settings-notifications-off',
  },
];

export function SettingsScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const dictationMode = useSettingsStore((state) => state.dictationMode);
  const setDictationMode = useSettingsStore((state) => state.setDictationMode);
  const backgroundNotificationsMode = useSettingsStore((state) => state.backgroundNotificationsMode);
  const setBackgroundNotificationsMode = useSettingsStore((state) => state.setBackgroundNotificationsMode);
  const hapticsEnabled = useSettingsStore((state) => state.hapticsEnabled);
  const setHapticsEnabled = useSettingsStore((state) => state.setHapticsEnabled);
  const transportState = useChannelStore((state) => state.transportState);
  const established = useChannelStore((state) => state.established);
  const relayUrl = useChannelStore((state) => state.relayUrl);
  const pairedState = useChannelStore((state) => state.pairedState);

  const connectionLabel =
    pairedState === 'unpaired'
      ? 'Not paired'
      : established
        ? 'Connected'
        : transportState === 'idle'
          ? 'Not connected'
          : transportState;

  return (
    <Screen testID="settings-screen">
      <Stack gap="md" style={{ padding: theme.spacing.lg }}>
        <Text variant="heading">Settings</Text>

        <Text variant="title">Connection</Text>
        <Stack gap="xs">
          <Row gap="sm" style={styles.connectionRow}>
            <StatusDot variant={established ? 'working' : 'idle'} testID="settings-connection-dot" />
            <Text variant="body" testID="settings-connection-label">
              {connectionLabel}
            </Text>
          </Row>
          {relayUrl ? (
            <View>
              <Text variant="caption" color="muted">
                Relay
              </Text>
              <MonoText size="caption" numberOfLines={1} testID="settings-relay-url">
                {relayUrl}
              </MonoText>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            testID="settings-devices-row"
            onPress={() => router.push('/devices')}
            style={({ pressed }) => [styles.linkRow, { minHeight: theme.minTouchSize, opacity: pressed ? 0.7 : 1 }]}
          >
            <Text variant="body" color="accent">
              Paired devices
            </Text>
            <Icon name="chevron-forward" color="secondary" size={16} />
          </Pressable>
          <Button testID="settings-pair-device" label="Pair a device" variant="ghost" onPress={() => router.push('/pair')} />
        </Stack>

        <Text variant="title">Notifications</Text>
        <Stack gap="xs">
          {NOTIFICATION_MODE_OPTIONS.map((option) => (
            <RadioRow
              key={option.mode}
              label={option.label}
              description={option.description}
              selected={option.mode === backgroundNotificationsMode}
              testID={option.testID}
              onPress={() => void setBackgroundNotificationsMode(option.mode)}
            />
          ))}
        </Stack>

        <Text variant="title">Feel</Text>
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: hapticsEnabled }}
          testID="settings-haptics-toggle"
          onPress={() => void setHapticsEnabled(!hapticsEnabled)}
          style={({ pressed }) => [styles.radioRow, { minHeight: theme.minTouchSize, gap: theme.spacing.sm, opacity: pressed ? 0.7 : 1 }]}
        >
          <Icon
            name={hapticsEnabled ? 'checkbox' : 'square-outline'}
            color={hapticsEnabled ? 'accent' : 'secondary'}
          />
          <View style={styles.radioLabels}>
            <Text variant="body" color="primary">
              Haptic feedback
            </Text>
            <Text variant="caption" color="secondary">
              A light tap on meaningful actions (answering prompts, moving tasks)
            </Text>
          </View>
        </Pressable>

        <Text variant="title">Dictation</Text>
        <Stack gap="xs">
          {DICTATION_OPTIONS.map((option) => (
            <RadioRow
              key={option.mode}
              label={option.label}
              description={option.description}
              selected={option.mode === dictationMode}
              testID={option.testID}
              onPress={() => void setDictationMode(option.mode)}
            />
          ))}
        </Stack>
      </Stack>
    </Screen>
  );
}

function RadioRow({
  label,
  description,
  selected,
  testID,
  onPress,
}: {
  label: string;
  description: string;
  selected: boolean;
  testID: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.radioRow,
        {
          minHeight: theme.minTouchSize,
          gap: theme.spacing.sm,
          paddingVertical: theme.spacing.xs,
          opacity: pressed ? 0.7 : 1,
        },
      ]}
    >
      <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} color={selected ? 'accent' : 'secondary'} />
      <View style={styles.radioLabels}>
        <Text variant="body" color="primary">
          {label}
        </Text>
        <Text variant="caption" color="secondary">
          {description}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  radioLabels: {
    flex: 1,
  },
  connectionRow: {
    alignItems: 'center',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
});
