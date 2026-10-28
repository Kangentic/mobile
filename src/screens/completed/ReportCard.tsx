import React from 'react';
import { Card, Text, useTheme } from '@/components';

/**
 * The completed task Summary's card chrome, after the desktop's `ReportCard`:
 * a title in the secondary text color with an optional count beside it, over
 * the card's body. The aside renders for 0 too, as the desktop's does.
 */
export function ReportCard({
  title,
  aside,
  testID,
  children,
}: {
  title: string;
  aside?: string | number | null;
  testID: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Card testID={testID} style={{ gap: theme.spacing.sm }}>
      <ReportCardTitle title={title} aside={aside} testID={testID} />
      {children}
    </Card>
  );
}

/**
 * The title line alone, for the Files changed card, whose body is split
 * across list rows.
 *
 * One Text with the count nested in it, not a row of two: inside a FlashList
 * item, Android measured a lone title in a flex row narrower than its text,
 * so "Task summary" wrapped and lost its second word (seen on the emulator).
 * A nested span also sits on the title's baseline with no alignment rule.
 */
export function ReportCardTitle({
  title,
  aside,
  testID,
}: {
  title: string;
  aside?: string | number | null;
  testID: string;
}): React.JSX.Element {
  return (
    <Text variant="bodyStrong" color="secondary" testID={`${testID}-title`}>
      {title}
      {aside !== undefined && aside !== null ? (
        <Text variant="caption" color="muted" testID={`${testID}-aside`}>
          {`  ${String(aside)}`}
        </Text>
      ) : null}
    </Text>
  );
}
