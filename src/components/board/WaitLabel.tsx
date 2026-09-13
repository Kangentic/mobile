import React from 'react';
import { Text, useNowTick, useTheme } from '@/components';
import { describeDuration, formatDuration } from '@/lib/formatDuration';

/**
 * Below this, render nothing at all - never "0m".
 *
 * A session that has just gone idle is not "waiting" in any sense the user
 * cares about, and a label that blinked on at every turn boundary is exactly
 * the "status filler" the Agents feed deliberately has none of. Holding it back
 * for the first minute is what makes it signal: text only appears beside a
 * snippet that has genuinely been sitting there.
 */
const MINIMUM_VISIBLE_MS = 60_000;

export interface WaitLabelProps {
  /** Epoch ms the session first needed the user - `selectWaitingSince`. */
  sinceMs: number;
  testID?: string;
}

/**
 * How long the message beside this has been waiting for a reply.
 *
 * ITS OWN COMPONENT ON PURPOSE, and the reason is the same one behind
 * `AgentStatusIcon`'s `SpinningMark`/`MarchingMark` split: this is the only
 * thing that subscribes to the shared clock, so a tick re-renders these leaves
 * and nothing else. Reading `useNowTick()` up in `TaskCard` would re-render
 * every card on the screen twice a minute, including the working rows that
 * have no time to show and never mount this at all.
 *
 * No animation, deliberately: a value that changes twice a minute sits at the
 * "platform default or nothing" end of `motion-conventions.md`'s frequency
 * gate, and a cross-fade on a number reads as a glitch rather than a change.
 * There is no Reanimated hook anywhere in this file and a test asserts it.
 */
export function WaitLabel({ sinceMs, testID }: WaitLabelProps): React.JSX.Element | null {
  const theme = useTheme();
  const nowMs = useNowTick();
  const rawElapsedMs = nowMs - sinceMs;
  if (rawElapsedMs < MINIMUM_VISIBLE_MS) return null;
  // TRUNCATED to whole minutes, not rounded. `formatDuration` rounds, which is
  // right for a finished run's summary but wrong for a counter still running:
  // it would report 90 seconds of waiting as '2m' and claim more delay than has
  // actually passed. Flooring also makes the label change exactly on the minute
  // rather than halfway through one, so a 30s tick never moves it twice.
  const elapsedMs = Math.floor(rawElapsedMs / 60_000) * 60_000;

  return (
    <Text
      variant="caption"
      // `statusNeedsYou`, not the `accent` role: both are brand amber today,
      // but a per-project accent (ProjectAccentBoundary) replaces the accent
      // family, and on a green-accented project this label would render in
      // statusWorking's hue and say the opposite of what it means. This is the
      // semantic role for the attention hue, so it cannot be re-pointed.
      style={{ color: theme.colors.statusNeedsYou }}
      numberOfLines={1}
      testID={testID}
      accessibilityLabel={`Waiting ${describeDuration(elapsedMs)}`}
    >
      {formatDuration(elapsedMs)}
    </Text>
  );
}
