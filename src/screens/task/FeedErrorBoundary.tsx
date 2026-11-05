import React from 'react';
import { StyleSheet } from 'react-native';
import { Button, Stack, Text } from '@/components';
import { reportCaughtError, type CaughtErrorBoundary } from '@/observability/crashReporting';

export interface FeedErrorBoundaryProps {
  /** Names the report, so a Sentry issue says which feed threw. */
  boundary: CaughtErrorBoundary;
  children: React.ReactNode;
}

interface FeedErrorBoundaryState {
  failed: boolean;
}

/**
 * Keeps a chat feed's crash inside its own pane. A feed is one lens of a screen
 * that also holds the terminal and the composer, and neither depends on it, but
 * without this a throw in the list reaches the root boundary and replaces the
 * whole app (Sentry MOBILE-F, a FlashList layout loop).
 *
 * A class because React has no hook for this. Reports from `componentDidCatch`
 * rather than render: render can run more than once for one error, and a caught
 * error never reaches the global handler, so this call is the only report.
 *
 * Try again remounts the feed from scratch. If it throws again the user lands
 * back here and one more event is reported, which is the right outcome for a
 * failure that follows the content.
 */
export class FeedErrorBoundary extends React.Component<FeedErrorBoundaryProps, FeedErrorBoundaryState> {
  override state: FeedErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): FeedErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    reportCaughtError(error, this.props.boundary);
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
  };

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Stack gap="sm" style={styles.fallback} testID="feed-error">
        <Text variant="body" color="secondary">
          Chat failed to load
        </Text>
        <Button label="Try again" variant="tinted" onPress={this.retry} testID="feed-error-retry" />
      </Stack>
    );
  }
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
