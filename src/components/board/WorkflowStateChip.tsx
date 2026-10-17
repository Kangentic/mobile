import React from 'react';
import { StyleSheet, View } from 'react-native';
import { CircleCheckBig, CircleDashed, Pause } from 'lucide-react-native';
import { AgentStatusIcon, Badge, Row, Text, hexWithAlpha, useTheme } from '@/components';
import { workflowCountLabel, workflowStateLabel, type WorkflowStateName } from '@/workflow/workflowState';

/*
 * The desktop's `WorkflowStateChip` (WorkflowPicker.tsx), measured 1:1: 20 high,
 * 6 across, radius 4, a 4 gap. Running is the working tint and ring at 10% and
 * 25%; Paused and Not started the same in grey; Complete a plain raised fill.
 * The one deviation is the text, 12 px where the desktop's is 11: 12 is the
 * phone's floor for a badge (ui-conventions.md).
 */
const CHIP_HEIGHT = 20;
const CHIP_INSET = 6;
const CHIP_RADIUS = 4;
const CHIP_GAP = 4;
const TINT_FILL_ALPHA = 0.1;
const TINT_RING_ALPHA = 0.25;
const STILL_GLYPH_SIZE = 11;
const RUNNING_RING_SIZE = 12;

/**
 * A workflow's state, as the desktop's chip says it: Running (the working ring,
 * turning), Paused, Not started (a draft), or Complete. The ring is
 * AgentStatusIcon's own, so it takes the same gates every other working mark
 * does (reduced motion, the screen's motion provider; read from that
 * component's source, not measured). A form sheet has no motion provider, so
 * on the Workflows sheet it turns while the sheet is open.
 */
export function WorkflowStateChip({ state, testID }: { state: WorkflowStateName; testID?: string }): React.JSX.Element {
  const theme = useTheme();
  const running = state === 'running';
  const tintColor = running ? theme.colors.statusWorking : theme.colors.textSecondary;
  const glyphColor = theme.colors.textSecondary;
  const chipStyle =
    state === 'done'
      ? { backgroundColor: theme.colors.surfaceRaised }
      : {
          backgroundColor: hexWithAlpha(tintColor, TINT_FILL_ALPHA),
          borderColor: hexWithAlpha(tintColor, TINT_RING_ALPHA),
          borderWidth: 1,
        };
  return (
    <View testID={testID} style={[styles.chip, chipStyle]}>
      {state === 'running' ? <AgentStatusIcon kind="working" size={RUNNING_RING_SIZE} /> : null}
      {state === 'paused' ? <Pause size={STILL_GLYPH_SIZE} color={glyphColor} /> : null}
      {state === 'draft' ? <CircleDashed size={STILL_GLYPH_SIZE} color={glyphColor} /> : null}
      {state === 'done' ? <CircleCheckBig size={STILL_GLYPH_SIZE} color={glyphColor} /> : null}
      <Text variant="caption" color={running ? 'success' : 'secondary'} style={styles.label}>
        {workflowStateLabel(state)}
      </Text>
    </View>
  );
}

/**
 * The line every workflow names itself with below its title (design screen 6):
 * the state chip, then the desktop's count, "1 of 6" once started and "5 tasks"
 * before. The same two parts in the same order on the Workflows sheet and the
 * workflow view's header. The count is left out until it is known.
 */
export function WorkflowSummary({
  state,
  doneCount,
  taskCount,
  testID,
}: {
  state: WorkflowStateName;
  doneCount: number | null;
  taskCount: number | null;
  testID: string;
}): React.JSX.Element {
  return (
    <Row gap="sm" style={styles.summary}>
      <WorkflowStateChip state={state} testID={`${testID}-state`} />
      {doneCount !== null && taskCount !== null ? (
        <Badge label={workflowCountLabel(state, doneCount, taskCount)} shape="pill" align="center" testID={`${testID}-count`} />
      ) : null}
    </Row>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: CHIP_GAP,
    height: CHIP_HEIGHT,
    paddingHorizontal: CHIP_INSET,
    borderRadius: CHIP_RADIUS,
  },
  label: {
    fontWeight: '500',
  },
  summary: {
    alignItems: 'center',
  },
});
