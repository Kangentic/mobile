import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { TaskReportCommitWire } from '@kangentic/protocol';
import { MonoText, Text, useTheme } from '@/components';
import { formatTimeAgo } from '@/taskReport/format';
import { ReportCard } from './ReportCard';

/** Wide enough for the longest time the column says, "58 minutes ago" or "11 months ago", at caption size. */
const SHA_COLUMN_WIDTH = 92;
const SHORT_SHA_LENGTH = 7;

/**
 * The commits the desktop's index links to the task, newest first, with "20
 * of 34" beside the title when it sent fewer than it found. Each row is the
 * short sha over when it was made (relative, as on the desktop), beside the
 * subject on up to two lines: a desktop-style single row holds only about 27
 * characters of subject at phone width. Display only: the desktop opens a
 * commit in its Changes tab, which a completed task does not have here.
 */
export function CommitsCard({
  commits,
  commitCount,
  nowMs,
}: {
  commits: TaskReportCommitWire[];
  commitCount: number;
  nowMs: number;
}): React.JSX.Element {
  const theme = useTheme();
  const aside = commitCount > commits.length ? `${commits.length} of ${commitCount}` : null;
  return (
    <ReportCard title="Commits" aside={aside} testID="completed-summary-commits">
      <View style={{ gap: theme.spacing.sm }}>
        {commits.map((commit) => {
          const shortSha = commit.sha.slice(0, SHORT_SHA_LENGTH);
          const when = formatTimeAgo(commit.committedAt, nowMs);
          return (
            <View
              key={commit.sha}
              testID={`completed-summary-commit-${shortSha}`}
              accessible
              accessibilityLabel={`Commit ${shortSha}, ${commit.subject}${when.length > 0 ? `, ${when}` : ''}`}
              style={[styles.row, { gap: theme.spacing.sm }]}
            >
              <View style={styles.shaColumn}>
                {/* The body line height, so the sha sits on the subject's first line. */}
                <MonoText size="caption" color="accent" style={{ lineHeight: theme.typography.body.lineHeight }}>
                  {shortSha}
                </MonoText>
                {when.length > 0 ? (
                  <Text variant="caption" color="muted" numberOfLines={1}>
                    {when}
                  </Text>
                ) : null}
              </View>
              <Text color="secondary" numberOfLines={2} style={styles.subject}>
                {commit.subject}
              </Text>
            </View>
          );
        })}
      </View>
    </ReportCard>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  shaColumn: {
    width: SHA_COLUMN_WIDTH,
  },
  subject: {
    flex: 1,
    minWidth: 0,
  },
});
