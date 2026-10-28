import React from 'react';
import { ScrollView } from 'react-native';
import { EmptyState, MarkdownBlock, useTheme } from '@/components';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';

/**
 * A completed task's description, in full, as the desktop's Description tab
 * shows it. One markdown block, not a list, so a ScrollView is the right host.
 *
 * GitHub flavor, so a `- [ ]` checklist draws read-only boxes as it does on
 * the desktop. It is the only surface on that renderer; the retention probe's
 * `description-commonmark` arm switches it back for the measurement that
 * gated it.
 *
 * Measured on a release build (kangentic_profile emulator, demo pairing,
 * 2026-10-27; one run per arm, so treat small differences as noise). Ten
 * open-and-close cycles of a checklist description, each arm in a fresh
 * process, two GC-settled meminfo samples: GitHub flavor 793 -> 794 Views and
 * +201 KB Dalvik heap, CommonMark 794 -> 794 Views and +184 KB. Five more
 * cycles per arm in ONE process: 658 frames, 5.78% janky, p99 18 ms against
 * 659 frames, 6.22% janky, p99 22 ms. No difference resolvable from one run
 * per arm; the run-to-run spread was not measured.
 */
export function DescriptionPane({ description }: { description: string }): React.JSX.Element {
  const theme = useTheme();
  if (description.trim().length === 0) {
    return <EmptyState testID="completed-description-empty" title="No description" overseerSize={54} />;
  }
  const flavor = getRetentionProbeVariant() === 'description-commonmark' ? 'commonmark' : 'github';
  return (
    <ScrollView
      testID="completed-description"
      contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
    >
      <MarkdownBlock markdown={description} flavor={flavor} testID="completed-description-markdown" />
    </ScrollView>
  );
}
