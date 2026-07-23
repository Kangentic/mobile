import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { isRecord, type JsonValue } from '@kangentic/protocol';
import { MonoText, useTheme } from '@/components';
import { buildUnifiedDiffLines } from '@/diff/diffLines';
import { splitPathForDisplay } from '@/diff/pathDisplay';
import type { ConversationCell } from '@/conversation/transcriptCells';
import { InlineDiff } from './InlineDiff';
import { MonoBlock } from './MonoBlock';
import { ToolResultBlock } from './ToolResultCell';
import { TurnFrame } from './TurnFrame';

type ToolCallCellModel = Extract<ConversationCell, { kind: 'tool-call' }>;

export interface ToolCallCardProps {
  cell: ToolCallCellModel;
}

/** Tools whose one-line summary shows the two-tone file path from `input.file_path`. */
const FILE_PATH_SUMMARY_TOOL_NAMES = new Set(['Edit', 'Write', 'Read', 'NotebookEdit']);
const WRITE_PREVIEW_LINE_COUNT = 20;

function stringInputField(input: JsonValue, fieldName: string): string | null {
  if (!isRecord(input)) {
    return null;
  }
  const fieldValue = input[fieldName];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

function firstLineOf(text: string): string {
  const newlineIndex = text.indexOf('\n');
  return (newlineIndex >= 0 ? text.slice(0, newlineIndex) : text).trim();
}

function summaryForTool(toolName: string, input: JsonValue): React.JSX.Element | null {
  if (toolName === 'Bash') {
    const command = stringInputField(input, 'command');
    if (command === null) return null;
    return (
      <MonoText size="caption" color="secondary" numberOfLines={1}>
        {firstLineOf(command)}
      </MonoText>
    );
  }
  if (FILE_PATH_SUMMARY_TOOL_NAMES.has(toolName)) {
    const filePath = stringInputField(input, 'file_path') ?? stringInputField(input, 'notebook_path');
    if (filePath === null) return null;
    const { directory, basename } = splitPathForDisplay(filePath);
    return (
      // ellipsizeMode="head" trims the directory prefix first on a long
      // path, not the filename at the end - the filename is the one piece
      // of this summary a user actually needs to see.
      <MonoText size="caption" numberOfLines={1} ellipsizeMode="head">
        <MonoText size="caption" color="muted">
          {directory}
        </MonoText>
        <MonoText size="caption" color="primary">
          {basename}
        </MonoText>
      </MonoText>
    );
  }
  if (toolName === 'Grep' || toolName === 'Glob') {
    const pattern = stringInputField(input, 'pattern');
    if (pattern === null) return null;
    return (
      <MonoText size="caption" color="secondary" numberOfLines={1}>
        {pattern}
      </MonoText>
    );
  }
  if (toolName === 'Task') {
    const description = stringInputField(input, 'description');
    if (description === null) return null;
    return (
      <MonoText size="caption" color="secondary" numberOfLines={1}>
        {description}
      </MonoText>
    );
  }
  return null;
}

function ExpandedToolInput({ toolName, input }: { toolName: string; input: JsonValue }): React.JSX.Element {
  const theme = useTheme();
  let body: React.JSX.Element | null = null;

  if (toolName === 'Edit') {
    const oldString = stringInputField(input, 'old_string');
    const newString = stringInputField(input, 'new_string');
    if (oldString !== null && newString !== null) {
      body = <InlineDiff lines={buildUnifiedDiffLines(oldString, newString)} />;
    }
  } else if (toolName === 'Write') {
    const content = stringInputField(input, 'content');
    if (content !== null) {
      const contentLines = content.split('\n');
      const previewText = contentLines.slice(0, WRITE_PREVIEW_LINE_COUNT).join('\n');
      body = <MonoBlock text={contentLines.length > WRITE_PREVIEW_LINE_COUNT ? `${previewText}\n...` : previewText} color="secondary" />;
    }
  }
  if (body === null) {
    body = <MonoBlock text={JSON.stringify(input, null, 2)} color="secondary" />;
  }

  return <View style={{ marginTop: theme.spacing.xs }}>{body}</View>;
}

/**
 * A tool_use block with its merged result: status glyph + tool name + a
 * per-tool one-line summary, tap to expand the input (Edit shows an inline
 * old/new diff), and a collapsed expandable result preview underneath. No
 * box of its own - it flows as plain content inside the turn's shared band,
 * same as a text block; the mono font, status glyph, and the result's own
 * left-border indent are enough to mark it as a tool call without stacking
 * another border on top.
 */
export function ToolCallCard({ cell }: ToolCallCardProps): React.JSX.Element {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  // Reset per-item UI state when FlashList recycles this component for a different tool call.
  const [trackedToolUseId, setTrackedToolUseId] = useState(cell.toolUseId);
  if (trackedToolUseId !== cell.toolUseId) {
    setTrackedToolUseId(cell.toolUseId);
    setExpanded(false);
  }

  const statusGlyph = cell.result === null ? '●' : cell.result.isError ? '✗' : '✓';
  const statusColor = cell.result === null ? ('secondary' as const) : cell.result.isError ? ('danger' as const) : ('success' as const);

  return (
    <TurnFrame turn={cell.turn}>
      <View>
        <Pressable
          accessibilityRole="button"
          testID={`tool-call-${cell.toolUseId}`}
          onPress={() => setExpanded((previousExpanded) => !previousExpanded)}
          style={[styles.headerRow, { minHeight: theme.minTouchSize, gap: theme.spacing.sm }]}
        >
          <MonoText size="caption" color={statusColor}>
            {statusGlyph}
          </MonoText>
          <MonoText size="caption" color="primary">
            {cell.toolName}
          </MonoText>
          <View style={styles.flex}>{summaryForTool(cell.toolName, cell.input)}</View>
        </Pressable>
        {expanded ? <ExpandedToolInput toolName={cell.toolName} input={cell.input} /> : null}
        {cell.result !== null ? (
          <ToolResultBlock
            content={cell.result.content}
            isError={cell.result.isError}
            testID={`tool-result-${cell.toolUseId}`}
          />
        ) : null}
      </View>
    </TurnFrame>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
