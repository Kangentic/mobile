import React, { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { Button, EmptyState } from '@/components';

/**
 * How long the link may be "coming up" before this stops narrating progress
 * and starts offering a way out. Long enough that a normal cold start over a
 * hosted relay never sees it, short enough that a genuinely stuck phone is not
 * left guessing.
 */
const OFFER_RECOVERY_AFTER_MS = 20_000;

/**
 * Paired but the secure channel is not established yet (cold start, relay
 * or desktop coming back): the Overseer holds the center instead of a
 * black void while the link comes up.
 *
 * After OFFER_RECOVERY_AFTER_MS it also offers the way out. This screen used
 * to wait forever with no timeout, no error, and no route to unpairing, so a
 * phone that never established had exactly one recovery left: uninstall and
 * reinstall the app. Unpairing is local and works with no channel at all
 * (DevicesScreen clears the trust anchor; the push unregister it tries first
 * is best-effort and swallows its own failures), so the escape hatch is
 * always available - it was simply never signposted from the one screen where
 * a user would need it.
 */
export function ConnectingEmptyState(): React.JSX.Element {
  const router = useRouter();
  const [offerRecovery, setOfferRecovery] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setOfferRecovery(true), OFFER_RECOVERY_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!offerRecovery) {
    return (
      <EmptyState
        testID="connecting-empty-state"
        title="Connecting to your desktop…"
        caption="Your agents appear here once it connects."
        overseerSize={90}
        overseerAnimate="blink-loop"
      />
    );
  }

  return (
    <EmptyState
      testID="connecting-empty-state"
      title="Still connecting"
      caption="Check your desktop is running."
      overseerSize={90}
      overseerAnimate="blink-loop"
    >
      <Button
        testID="connecting-manage-device"
        label="Manage device"
        variant="ghost"
        onPress={() => router.push('/devices')}
      />
    </EmptyState>
  );
}
