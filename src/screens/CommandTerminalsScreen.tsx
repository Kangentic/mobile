import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { PixelRatio, Pressable, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import type { CommandTerminalEarlierConversationWire } from '@kangentic/protocol';
import {
  ActivityMarkIcon,
  Button,
  Icon,
  NowTickProvider,
  Row,
  SheetScrollerSlot,
  Stack,
  StatusSpinner,
  Text,
  sheetRowSurface,
  useNowTick,
  useTheme,
} from '@/components';
import { fetchEarlierConversations, launchCommandTerminal, resumeCommandTerminal, stopCommandTerminal } from '@/connection/actions';
import { formatActivityLine } from '@/lib/activityLine';
import {
  LIST_FLOOR_HEIGHT,
  SHEET_ROW_GAP,
  clampSheetContentHeight,
  estimatedEarlierRowHeight,
  terminalsSheetReservedHeight,
} from '@/lib/sheetContentHeights';
import { useActivityStore } from '@/state/activityStore';
import {
  COMMAND_TERMINAL_LIMIT,
  selectCommandTerminals,
  selectCommandTerminalsOffered,
  selectEarlierConversationsOffered,
  useBoardStore,
} from '@/state/boardStore';
import { hasConversationName, selectEarlierList, useCommandTerminalStore } from '@/state/commandTerminalStore';
import { formatEndedLabel } from '@/taskReport/format';
import {
  NO_EARLIER_CONVERSATIONS,
  commandTerminalTone,
  projectTerminals,
  visibleEarlierConversations,
  type ProjectTerminal,
} from './terminals/terminalDisplay';

/** Shown under the list while any row's Stop was refused (design change 3). */
export const STOP_FAILED_MESSAGE = 'Stop failed - check the connection';
/** Under the Earlier heading when the list could not be read and none was held (task #160 design change 7). */
export const EARLIER_READ_FAILED_MESSAGE = "Earlier didn't load - check the connection";
/** What an Earlier row reads as when the conversation has neither a name nor a first prompt: the desktop's words. */
export const UNTITLED_CONVERSATION_NAME = 'Untitled conversation';

const ROW_MARK_SIZE = 18;
const STOP_MARK_SIZE = 16;
const HISTORY_GLYPH_SIZE = 16;
const STOP_ACCESSIBILITY_ACTIONS = [{ name: 'stop', label: 'Stop' }];

/** An Earlier row's height before one has been laid out, at the OS font scale (see `estimatedEarlierRowHeight`). */
function initialEarlierRowHeight(): number {
  return estimatedEarlierRowHeight(PixelRatio.getFontScale(), StyleSheet.hairlineWidth);
}

/**
 * A project's Command Terminals, as a native form sheet route (design changes
 * 2 and 3): the title, one raised row per terminal with its name over what it
 * is doing, a one-tap Stop on each, and New terminal, greyed out at four with
 * no text under it.
 *
 * Under New, the desktop's Earlier list (protocol 0.24.0, task #160): the
 * project's ended conversations that can still be resumed, newest first, each
 * its name over when it ended. A tap resumes it in a new terminal. Shown only
 * when the desktop offers it and there is something in it (or its read failed
 * with nothing held); the Running heading over the live rows comes with it
 * (decision B1). Read on opening, and re-read whenever the project's
 * terminals change.
 *
 * A row opens its terminal by REPLACING this sheet rather than pushing over
 * it: a stack screen pushed after a native modal is expected to open inside
 * that modal's own presentation on iOS (react-native-screens nests it; recalled
 * from the library, not yet observed on a device here). New and an Earlier row
 * do the same, so a start that fails routes back to the Board.
 *
 * The sheet closes once there is nothing left to show: no terminal running or
 * starting, no Earlier row, no Earlier read on its way, and no failed read
 * whose line it would hide. A used terminal
 * that ends joins Earlier, so stopping the last one keeps the sheet open on its
 * conversation (design change 2).
 */
export function CommandTerminalsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { projectId: projectIdParam } = useLocalSearchParams<{ projectId?: string }>();
  const projectId = projectIdParam !== undefined && projectIdParam.length > 0 ? projectIdParam : null;
  const listed = useBoardStore((state) => selectCommandTerminals(state, projectId));
  // The Board button hides itself when the desktop stops offering the verb;
  // a sheet already open keeps its rows but stops offering New.
  const offered = useBoardStore((state) => selectCommandTerminalsOffered(state, projectId));
  const earlierOffered = useBoardStore((state) => selectEarlierConversationsOffered(state, projectId));
  const launchesById = useCommandTerminalStore((state) => state.launchesById);
  const stopsBySessionId = useCommandTerminalStore((state) => state.stopsBySessionId);
  const earlierList = useCommandTerminalStore((state) => selectEarlierList(state, projectId));
  const launches = useMemo(() => Object.values(launchesById), [launchesById]);
  const terminals = useMemo(() => (projectId !== null ? projectTerminals(listed, launches, projectId) : []), [listed, launches, projectId]);
  const earlierRows = useMemo(
    () =>
      earlierOffered && projectId !== null
        ? visibleEarlierConversations(earlierList?.conversations ?? null, launches, projectId)
        : NO_EARLIER_CONVERSATIONS,
    [earlierOffered, earlierList, launches, projectId],
  );
  const anyNeedsYou = useActivityStore((state) =>
    terminals.some((terminal) => terminal.sessionId !== null && commandTerminalTone(state.bySessionId[terminal.sessionId] ?? null) === 'needs-you'),
  );
  const stopFailed = terminals.some((terminal) => terminal.sessionId !== null && stopsBySessionId[terminal.sessionId] === 'failed');
  const atLimit = terminals.length >= COMMAND_TERMINAL_LIMIT;
  const earlierLoading = earlierOffered && earlierList?.status === 'loading';
  const earlierReadFailed = earlierOffered && earlierList?.status === 'failed' && earlierList.conversations === null;
  const earlierSectionShown = earlierRows.length > 0 || earlierReadFailed;

  // Read on opening, and again if the offer only arrives with a later snapshot.
  useEffect(() => {
    if (projectId !== null && earlierOffered) void fetchEarlierConversations(projectId);
  }, [earlierOffered, projectId]);

  // Closes once there is nothing left to show: the last terminal stopped or
  // ended while the sheet was open, with nothing in Earlier, no Earlier read
  // on its way (an ended terminal's conversation arrives on one), and no
  // failed read to say so (design change 7: closing would hide the failure,
  // and the Board button would read as having nothing to resume).
  const empty = terminals.length === 0 && earlierRows.length === 0 && !earlierLoading && !earlierReadFailed;
  useEffect(() => {
    if (empty && router.canGoBack()) router.back();
  }, [empty, router]);

  const openTerminal = useCallback(
    (sessionId: string) => {
      if (projectId === null) return;
      router.replace({ pathname: '/command-terminal', params: { sessionId, projectId } });
    },
    [projectId, router],
  );

  const onNew = useCallback(() => {
    if (projectId === null || !offered) return;
    const launchId = launchCommandTerminal(projectId);
    router.replace({ pathname: '/command-terminal', params: { launchId, projectId } });
  }, [offered, projectId, router]);

  const onResume = useCallback(
    (conversation: CommandTerminalEarlierConversationWire) => {
      if (projectId === null || atLimit) return;
      const launchId = resumeCommandTerminal(projectId, conversation);
      if (launchId === null) return;
      router.replace({ pathname: '/command-terminal', params: { launchId, projectId } });
    },
    [atLimit, projectId, router],
  );

  const listMaxHeight = clampSheetContentHeight({
    windowHeight,
    reservedHeight: terminalsSheetReservedHeight(terminals.length, PixelRatio.getFontScale()) + insets.bottom,
    floorHeight: LIST_FLOOR_HEIGHT,
  });

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surfaceOverlay, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl + insets.bottom }]}
      testID="command-terminals-sheet"
    >
      <NowTickProvider enabled={anyNeedsYou || earlierRows.length > 0}>
        <Stack gap="sm">
          <Text variant="title">Command Terminals</Text>
          {earlierSectionShown && terminals.length > 0 ? <SectionHeading label="Running" testID="command-terminals-running-heading" /> : null}
          {terminals.length > 0 ? (
            <Stack gap="xs">
              {terminals.map((terminal) => (
                <TerminalRow
                  key={terminal.sessionId ?? `starting-${terminal.slot}`}
                  terminal={terminal}
                  stopping={terminal.sessionId !== null && stopsBySessionId[terminal.sessionId] === 'stopping'}
                  onOpen={openTerminal}
                />
              ))}
            </Stack>
          ) : null}
          {stopFailed ? (
            <Text variant="caption" color="danger" testID="command-terminals-stop-failed">
              {STOP_FAILED_MESSAGE}
            </Text>
          ) : null}
          <Button
            label="New terminal"
            leading={<ActivityMarkIcon mark="terminal-new" tone="rest" size={ROW_MARK_SIZE} />}
            variant="primary"
            disabled={atLimit || projectId === null || !offered}
            onPress={onNew}
            testID="command-terminals-new"
          />
          {earlierSectionShown ? (
            <>
              <View style={[styles.rule, { backgroundColor: theme.colors.border }]} testID="command-terminals-earlier-rule" />
              <SectionHeading label="Earlier" testID="command-terminals-earlier-heading" />
              {earlierRows.length > 0 ? (
                <EarlierList rows={earlierRows} disabled={atLimit} maxHeight={listMaxHeight} onResume={onResume} />
              ) : (
                <Text variant="caption" color="danger" style={{ paddingHorizontal: theme.spacing.md }} testID="command-terminals-earlier-failed">
                  {EARLIER_READ_FAILED_MESSAGE}
                </Text>
              )}
            </>
          ) : null}
        </Stack>
      </NowTickProvider>
    </View>
  );
}

/** "Running" or "Earlier": the desktop rail's muted caption heading, aligned with the rows' content. */
function SectionHeading({ label, testID }: { label: string; testID: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text variant="caption" color="muted" style={{ paddingTop: theme.spacing.xs, paddingHorizontal: theme.spacing.md }} testID={testID}>
      {label}
    </Text>
  );
}

/**
 * The Earlier rows, virtualized (the desktop sends up to 500), in a list as
 * tall as its rows up to the sheet's cap, past which it scrolls inside the
 * sheet. The height is explicit because FlashList renders nothing without a
 * bounded viewport, and a 'fitToContents' sheet gives it none; it is taken
 * from the first row's own layout once there is one, so a large OS font
 * neither clips the last row nor scrolls a short list.
 */
function EarlierList({
  rows,
  disabled,
  maxHeight,
  onResume,
}: {
  rows: readonly CommandTerminalEarlierConversationWire[];
  disabled: boolean;
  maxHeight: number;
  onResume: (conversation: CommandTerminalEarlierConversationWire) => void;
}): React.JSX.Element {
  const [rowHeight, setRowHeight] = useState(initialEarlierRowHeight);
  const onFirstRowLayout = useCallback((event: LayoutChangeEvent) => {
    const measured = Math.ceil(event.nativeEvent.layout.height);
    setRowHeight((current) => (measured > 0 && measured !== current ? measured : current));
  }, []);
  const listHeight = Math.min(rows.length * rowHeight + (rows.length - 1) * SHEET_ROW_GAP, maxHeight);

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<CommandTerminalEarlierConversationWire>) => (
      <EarlierRow conversation={item} disabled={disabled} onResume={onResume} onLayout={index === 0 ? onFirstRowLayout : undefined} />
    ),
    [disabled, onFirstRowLayout, onResume],
  );

  // The height goes on FlashList's own container (its `style`), which its
  // internal ScrollView fills, so the scroll view itself is bounded and
  // scrolls: SheetScrollerSlot's invariant that no wrapper above the scroller
  // carries the cap.
  return (
    <SheetScrollerSlot>
      <FlashList
        data={rows}
        renderItem={renderItem}
        keyExtractor={earlierRowKey}
        ItemSeparatorComponent={EarlierRowGap}
        keyboardShouldPersistTaps="handled"
        extraData={disabled}
        style={{ height: listHeight }}
        testID="command-terminals-earlier-list"
      />
    </SheetScrollerSlot>
  );
}

function earlierRowKey(conversation: CommandTerminalEarlierConversationWire): string {
  return conversation.agentSessionId;
}

function EarlierRowGap(): React.JSX.Element {
  return <View style={styles.earlierRowGap} />;
}

/**
 * One ended conversation, as the desktop rail's Earlier row reads: its History
 * glyph, its name (the terminal's name when it ended, else its first prompt)
 * on one line, and when it ended ("2 hours ago", "yesterday", then the date).
 * A tap resumes it. At four terminals it is greyed out and inert, as New is,
 * with no reason under it (the desktop's reason is a hover tip).
 */
const EarlierRow = memo(function EarlierRow({
  conversation,
  disabled,
  onResume,
  onLayout,
}: {
  conversation: CommandTerminalEarlierConversationWire;
  disabled: boolean;
  onResume: (conversation: CommandTerminalEarlierConversationWire) => void;
  onLayout: ((event: LayoutChangeEvent) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const nowMs = useNowTick();
  // A blank name from the desktop reads as no name, rather than an empty line
  // and a "Resume " label. Uncapped: the line clips to one, and the full name
  // is the screen reader's, as the desktop's hover tip shows it in full.
  const name = hasConversationName(conversation.name) ? conversation.name : UNTITLED_CONVERSATION_NAME;
  const testIdKey = `command-terminal-earlier-row-${conversation.agentSessionId}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Resume ${name}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => onResume(conversation)}
      onLayout={onLayout}
      testID={testIdKey}
      style={[
        styles.row,
        sheetRowSurface(theme),
        { minHeight: theme.minTouchSize, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm, opacity: disabled ? 0.4 : 1 },
      ]}
    >
      <Row gap="sm" style={styles.rowContent}>
        <View style={styles.glyphSlot}>
          <Icon name="history" color="muted" size={HISTORY_GLYPH_SIZE} />
        </View>
        <Stack gap="xs" style={styles.flex}>
          <Text variant="body" numberOfLines={1} testID={`${testIdKey}-name`}>
            {name}
          </Text>
          <Text variant="caption" color="muted" numberOfLines={1} testID={`${testIdKey}-ended`}>
            {formatEndedLabel(conversation.endedAt, nowMs)}
          </Text>
        </Stack>
      </Row>
    </Pressable>
  );
});

/**
 * One terminal: its mark in its tone, its name over the desktop's words for
 * what it is doing, and a one-tap Stop. Stopping dims the row and reads
 * "Stopping..." until the desktop has ended it and the board drops the row.
 */
function TerminalRow({
  terminal,
  stopping,
  onOpen,
}: {
  terminal: ProjectTerminal;
  stopping: boolean;
  onOpen: (sessionId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const nowMs = useNowTick();
  const sessionId = terminal.sessionId;
  const entry = useActivityStore((state) => (sessionId !== null ? (state.bySessionId[sessionId] ?? null) : null));
  const tone = commandTerminalTone(entry);
  const activityLine = stopping
    ? 'Stopping...'
    : entry !== null
      ? formatActivityLine(entry, nowMs)
      : 'Starting...';
  const testIdKey = sessionId ?? `starting-${terminal.slot}`;
  const stopAvailable = sessionId !== null && !stopping;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${terminal.name}`}
      accessibilityState={{ disabled: sessionId === null || stopping }}
      // The row is one accessibility element (an accessible view groups its
      // children on iOS), so the Stop nested in it is also offered as the
      // row's own action, or a screen reader could open a terminal but never
      // stop it from here.
      accessibilityActions={stopAvailable ? STOP_ACCESSIBILITY_ACTIONS : undefined}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'stop' && sessionId !== null) void stopCommandTerminal(sessionId);
      }}
      disabled={sessionId === null || stopping}
      onPress={() => {
        if (sessionId !== null) onOpen(sessionId);
      }}
      testID={`command-terminal-row-${testIdKey}`}
      style={[styles.row, sheetRowSurface(theme), { minHeight: theme.minTouchSize, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }]}
    >
      <Row gap="sm" style={[styles.rowContent, { opacity: stopping ? 0.5 : 1 }]}>
        <ActivityMarkIcon mark="terminal-idle" tone={stopping ? 'rest' : tone} size={ROW_MARK_SIZE} />
        <Stack gap="xs" style={styles.flex}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {terminal.name}
          </Text>
          <Text variant="caption" color="muted" numberOfLines={1} testID={`command-terminal-row-${testIdKey}-activity`}>
            {activityLine}
          </Text>
        </Stack>
        {stopping ? (
          <View style={[styles.stopTarget, { minWidth: theme.minTouchSize, minHeight: theme.minTouchSize }]}>
            <StatusSpinner size={STOP_MARK_SIZE} color={theme.colors.textMuted} testID={`command-terminal-row-${testIdKey}-stopping`} />
          </View>
        ) : sessionId !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${terminal.name}`}
            onPress={() => void stopCommandTerminal(sessionId)}
            testID={`command-terminal-row-${testIdKey}-stop`}
            style={({ pressed }) => [
              styles.stopButton,
              {
                minHeight: theme.minTouchSize,
                paddingHorizontal: theme.spacing.sm,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Row gap="xs" style={styles.rowContent}>
              <ActivityMarkIcon mark="control-stop-idle" tone="rest" size={STOP_MARK_SIZE} />
              <Text variant="caption" color="secondary">
                Stop
              </Text>
            </Row>
          </Pressable>
        ) : null}
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  row: {
    justifyContent: 'center',
  },
  rowContent: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
  glyphSlot: {
    width: ROW_MARK_SIZE,
    height: ROW_MARK_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rule: {
    height: StyleSheet.hairlineWidth,
  },
  earlierRowGap: {
    height: SHEET_ROW_GAP,
  },
  stopTarget: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
