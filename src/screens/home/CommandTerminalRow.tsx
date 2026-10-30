import React, { useCallback, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ActivityMarkIcon, Card, Row, Stack, Text, useTheme } from '@/components';
import { CommandTerminalPill } from '@/components/board/CommandTerminalPill';
import { cardStatusFooter } from '@/components/board/CardStatusFooter';
import { CardStripBleed } from '@/components/board/CardStrip';
import { cardSessionDisplay, toCardSession } from '@/components/board/cardSessionDisplay';
import { ColumnStrip } from '@/components/board/ColumnStrip';
import { formatActivityLine } from '@/lib/activityLine';
import { selectWaitingSince, type SessionActivityEntry } from '@/state/activityStore';
import { COMMAND_TERMINAL_FALLBACK_NAME, selectCommandTerminal, useBoardStore } from '@/state/boardStore';
import { commandTerminalTone } from '@/screens/terminals/terminalDisplay';
import { SectionLandingPulse } from './SectionLandingPulse';

/** The same fixed two-line body slot the task cards on this feed reserve (see ActivityRow). */
const SNIPPET_LINES = 2;
const STATUS_MARK_SIZE = 16;
const NO_TRACK: readonly never[] = [];

/**
 * A Command Terminal on the Agents feed (design changes 4 and 5, decision
 * G1): the task card's shape, so a terminal sits beside task agents in Idle,
 * Active and the rest, ordered the same way. What makes it a terminal at a
 * glance:
 *
 * - The band names the project and the wait as a task's does, and carries the
 *   "Command Terminal" pill where a task draws its column track, ALWAYS, named
 *   or not, so a terminal never has to be told apart from a task by its title.
 * - The title row leads with the terminal mark in its tone (green working,
 *   amber needs you) and has no #number.
 *
 * Its body is the agent's last line when the desktop pushes one, else the
 * desktop's words for what it is doing ("Running Bash", "Asking you a
 * question"), without a duration, which the band already shows. No branch
 * anywhere (decision E1).
 *
 * Tap opens the terminal; long-press opens its two actions (design change 19).
 */
export const CommandTerminalRow = React.memo(function CommandTerminalRow({ entry }: { entry: SessionActivityEntry }): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const terminal = useBoardStore((state) => selectCommandTerminal(state, entry.sessionId));
  const projectName = useBoardStore((state) => state.projects.find((project) => project.id === entry.projectId)?.name ?? null);
  const name = terminal?.name ?? COMMAND_TERMINAL_FALLBACK_NAME;
  const tone = commandTerminalTone(entry);
  const sessionDisplay = cardSessionDisplay({ session: toCardSession(entry), respawn: null, task: null });
  const waitingSinceMs = sessionDisplay.kind === 'running' && entry.activityObserved ? selectWaitingSince(entry) : null;
  const testID = `terminal-row-${entry.sessionId}`;

  const openTerminal = useCallback(() => {
    router.push({ pathname: '/command-terminal', params: { sessionId: entry.sessionId, projectId: entry.projectId } });
  }, [router, entry.sessionId, entry.projectId]);
  const openActions = useCallback(() => {
    router.push({ pathname: '/command-terminal-actions', params: { sessionId: entry.sessionId, projectId: entry.projectId } });
  }, [router, entry.sessionId, entry.projectId]);

  const pill = useMemo(() => <CommandTerminalPill testID={`${testID}-pill`} />, [testID]);
  const bodyText = entry.messagePreview ?? formatActivityLine(entry, null);
  const footer = cardStatusFooter({ display: sessionDisplay, usage: entry.usage, testID });

  return (
    <Card testID={testID} onPress={openTerminal} onLongPress={openActions}>
      <CardStripBleed testID={`${testID}-strips`}>
        <ColumnStrip
          column={null}
          track={NO_TRACK}
          projectName={projectName}
          waitingSinceMs={waitingSinceMs}
          waitTestID={`${testID}-wait`}
          testID={`${testID}-band`}
          trailing={pill}
        />
      </CardStripBleed>
      {entry.sectionChangedAt !== null ? (
        <SectionLandingPulse key={`${entry.sessionId}:${entry.sectionChangedAt}`} changedAtMs={entry.sectionChangedAt} testID={`${testID}-pulse`} />
      ) : null}
      <Stack gap="xs">
        <Row gap="sm" style={styles.titleRow}>
          <ActivityMarkIcon mark="terminal-idle" tone={tone} size={STATUS_MARK_SIZE} testID={`${testID}-mark-${tone}`} />
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1} testID={`${testID}-name`}>
            {name}
          </Text>
        </Row>
        <View style={{ height: theme.typography.caption.lineHeight * SNIPPET_LINES, justifyContent: 'center' }}>
          <Text variant="caption" color="muted" numberOfLines={SNIPPET_LINES} testID={`${testID}-snippet`}>
            {bodyText}
          </Text>
        </View>
        {footer !== null ? (
          <View style={[styles.footer, { borderTopColor: theme.colors.border, marginTop: theme.spacing.xs, paddingTop: theme.spacing.sm }]}>
            {footer}
          </View>
        ) : null}
      </Stack>
    </Card>
  );
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  titleRow: {
    alignItems: 'center',
  },
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
