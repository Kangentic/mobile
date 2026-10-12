import React, { useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { ActivityMarkIcon, PressScale, Row, Text, useTheme } from '@/components';
import { launchCommandTerminal } from '@/connection/actions';
import { useActivityStore } from '@/state/activityStore';
import { selectCommandTerminals, selectCommandTerminalsOffered, useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { commandTerminalTone, projectTerminals, terminalsButtonState, type CommandTerminalTone } from './terminalDisplay';

const MARK_SIZE = 18;

/**
 * The Board header's Terminals button (design change 1, decision A1): the
 * project's Command Terminals at a glance, beside Settings.
 *
 * - Nothing running: the desktop's "new terminal" mark alone. One tap starts a
 *   terminal and opens it (change 4), with no sheet in between.
 * - Running: the terminal mark and the count, amber when any terminal is idle
 *   or asking, green while all are working. A tap opens the sheet (change 2).
 *
 * Hidden unless the desktop offers the verb to this phone
 * (`commandTerminalsOffered`, protocol 0.20.0): an older desktop, or a grant
 * narrowed on the desktop's devices panel, has no Terminals to offer.
 */
export function TerminalsButton({ projectId }: { projectId: string }): React.JSX.Element | null {
  const theme = useTheme();
  const router = useRouter();
  const offered = useBoardStore((state) => selectCommandTerminalsOffered(state, projectId));
  const listed = useBoardStore((state) => selectCommandTerminals(state, projectId));
  const launchesById = useCommandTerminalStore((state) => state.launchesById);
  const terminals = useMemo(() => projectTerminals(listed, Object.values(launchesById), projectId), [listed, launchesById, projectId]);
  // A joined string rather than an array, so an activity event that changes no
  // terminal's tone does not re-render the header.
  const toneKey = useActivityStore((state) =>
    terminals.map((terminal) => commandTerminalTone(terminal.sessionId !== null ? (state.bySessionId[terminal.sessionId] ?? null) : null)).join(','),
  );
  const tones = useMemo(() => (toneKey.length === 0 ? [] : (toneKey.split(',') as CommandTerminalTone[])), [toneKey]);
  const buttonState = terminalsButtonState(tones);

  const onPress = useCallback(() => {
    if (buttonState.kind === 'new') {
      const launchId = launchCommandTerminal(projectId);
      router.push({ pathname: '/command-terminal', params: { launchId, projectId } });
      return;
    }
    router.push({ pathname: '/command-terminals', params: { projectId } });
  }, [buttonState.kind, projectId, router]);

  if (!offered) return null;

  const accessibilityLabel =
    buttonState.kind === 'new'
      ? 'New Command Terminal'
      : `Command Terminals, ${buttonState.count} running${buttonState.tone === 'needs-you' ? ', one or more need you' : ''}`;

  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID="header-terminals-button"
      onPress={onPress}
      style={[
        styles.pill,
        {
          minHeight: theme.minTouchSize,
          minWidth: theme.minTouchSize,
          paddingHorizontal: buttonState.kind === 'new' ? theme.spacing.sm : theme.spacing.md,
          borderRadius: theme.minTouchSize / 2,
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
        },
      ]}
    >
      {buttonState.kind === 'new' ? (
        <ActivityMarkIcon mark="terminal-new" tone="rest" size={MARK_SIZE} testID="header-terminals-new" />
      ) : (
        <Row gap="xs" style={styles.content}>
          <ActivityMarkIcon mark="terminal-idle" tone={buttonState.tone} size={MARK_SIZE} testID={`header-terminals-${buttonState.tone}`} />
          <Text variant="bodyStrong" testID="header-terminals-count">
            {buttonState.count}
          </Text>
        </Row>
      )}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  content: {
    alignItems: 'center',
  },
});
