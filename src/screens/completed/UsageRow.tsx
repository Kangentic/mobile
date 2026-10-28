import React from 'react';
import type { SessionSummaryWire } from '@kangentic/protocol';
import { formatTokenCount } from '@/taskReport/format';
import { FigureRow, type FigureCellSpec } from './FigureRow';
import { ReportCard } from './ReportCard';

/**
 * The session's usage figures as one row in the strip's style, last in
 * Summary. The desktop gives these a Usage tab; four figures do not earn a
 * footer segment on a phone (approved design D4), so they sit here.
 */
export function UsageRow({ summary }: { summary: SessionSummaryWire }): React.JSX.Element {
  const cells: FigureCellSpec[] = [];
  if (summary.modelDisplayName.length > 0) {
    cells.push({ key: 'model', label: 'Model', value: summary.modelDisplayName, accessibilityLabel: `Model ${summary.modelDisplayName}` });
  }
  const input = formatTokenCount(summary.totalInputTokens);
  const output = formatTokenCount(summary.totalOutputTokens);
  const toolCalls = formatTokenCount(summary.toolCallCount);
  cells.push(
    { key: 'input', label: 'Input', value: input, accessibilityLabel: `${input} input tokens` },
    { key: 'output', label: 'Output', value: output, accessibilityLabel: `${output} output tokens` },
    { key: 'tool-calls', label: 'Tool calls', value: toolCalls, accessibilityLabel: `${toolCalls} tool calls` },
  );
  return (
    <ReportCard title="Usage" testID="completed-summary-usage">
      <FigureRow cells={cells} testID="completed-summary-usage-figures" />
    </ReportCard>
  );
}
