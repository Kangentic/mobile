import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen, Stack, Text, Button, Icon, useTheme } from '@/components';
import { useSettingsStore, type DictationMode } from '@/state/settingsStore';

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

export function SettingsScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const dictationMode = useSettingsStore((state) => state.dictationMode);
  const setDictationMode = useSettingsStore((state) => state.setDictationMode);

  return (
    <Screen testID="settings-screen">
      <Stack gap="md" style={{ padding: theme.spacing.lg }}>
        <Text variant="heading">Settings</Text>
        <Text variant="body" color="secondary">
          Relay configuration lands in a later phase.
        </Text>
        <Button testID="settings-pair-device" label="Pair a device" onPress={() => router.push('/pair')} />

        <Text variant="title">Dictation</Text>
        <Stack gap="xs">
          {DICTATION_OPTIONS.map((option) => {
            const selected = option.mode === dictationMode;
            return (
              <Pressable
                key={option.mode}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                testID={option.testID}
                onPress={() => void setDictationMode(option.mode)}
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
                <Icon
                  name={selected ? 'radio-button-on' : 'radio-button-off'}
                  color={selected ? 'accent' : 'secondary'}
                />
                <View style={styles.radioLabels}>
                  <Text variant="body" color="primary">
                    {option.label}
                  </Text>
                  <Text variant="caption" color="secondary">
                    {option.description}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </Stack>
      </Stack>
    </Screen>
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
});
