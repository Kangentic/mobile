import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '@/components';
import { TaskCard, type TaskCardProps } from '@/components/board/TaskCard';
import { PR_READINESS_FRESHNESS_CAVEAT } from '@/components/board/prChipPresentation';
import { boardTaskFixture, usageFixture } from '@/devsupport/desktopFixtures';

const BASE_TEST_ID = 'task-card';

function renderTaskCard(overrides: Partial<TaskCardProps> = {}): void {
  const props: TaskCardProps = {
    testID: BASE_TEST_ID,
    task: boardTaskFixture(),
    statusKind: null,
    showTicketNumbers: false,
    usage: null,
    bodyText: 'A task worth doing.',
    onPress: jest.fn(),
    ...overrides,
  };
  render(
    <ThemeProvider>
      <TaskCard {...props} />
    </ThemeProvider>,
  );
}

/**
 * The labels Row never carries its own testID (only its children do), so
 * the only way to reach it and fire its onLayout handler is to start from a
 * rendered label and walk up the tree to the nearest ancestor that actually
 * owns the handler.
 */
function findAncestorWithLayoutHandler(instance: ReactTestInstance): ReactTestInstance {
  let currentInstance: ReactTestInstance | null = instance;
  while (currentInstance !== null) {
    if (typeof currentInstance.props.onLayout === 'function') return currentInstance;
    currentInstance = currentInstance.parent;
  }
  throw new Error('No ancestor with an onLayout handler was found.');
}

describe('TaskCard', () => {
  it('every sub-part testID is queryable - regression guard for lucide forwarding testID as the web-only data-testid, which RNTL cannot select unless the glyph is wrapped', () => {
    renderTaskCard({
      task: boardTaskFixture({ pr_number: 42 }),
      statusKind: 'working',
      showTicketNumbers: true,
      usage: usageFixture(),
      projectName: 'Kangentic Mobile',
      bodyText: 'A live inbox-style snippet.',
    });

    expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-usage`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-project`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-display-id`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-status`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-snippet`)).toBeTruthy();
  });

  it('renders the utility strip for an over-budget usage report instead of hiding it - desktop parity for a critical, not untrustworthy, state', () => {
    // Kills a restoration of the old hide-when-over-budget gate
    // (`isContextWindowKnown(usage) && usedTokens <= contextWindowSize`):
    // that mutation stays green against every other fixture in this file,
    // which all report usedTokens comfortably under contextWindowSize.
    renderTaskCard({
      usage: usageFixture({
        contextWindow: {
          usedPercentage: 92,
          usedTokens: 210_000,
          cacheTokens: 800,
          totalInputTokens: 3200,
          totalOutputTokens: 500,
          contextWindowSize: 200_000,
        },
      }),
    });

    expect(screen.getByTestId(`${BASE_TEST_ID}-usage`)).toBeTruthy();
  });

  it('showMetaRow={false} suppresses the labels row and the PR icon - its only coverage, since no caller passes this yet', () => {
    renderTaskCard({
      task: boardTaskFixture({ pr_number: 42, labels: ['backend', 'p0'] }),
      showMetaRow: false,
    });

    expect(screen.queryByTestId(`${BASE_TEST_ID}-pr`)).toBeNull();
    expect(screen.queryByText('backend')).toBeNull();
    expect(screen.queryByText('p0')).toBeNull();
  });

  describe('PR merge readiness', () => {
    it('labels the chip while the PR is open and the verdict says something', () => {
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: 'conflicting' }),
      });

      // Text, not color: a color assertion passes by accident the moment the
      // token it reads happens to match. The wire says `conflicting`; the card
      // must say `conflicts`.
      expect(screen.getByText('conflicts')).toBeTruthy();
      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
    });

    it('spends no title width on an open PR with no verdict', () => {
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: null }),
      });

      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
      expect(screen.queryByText('open')).toBeNull();
      expect(screen.queryByText('ready')).toBeNull();
    });

    it('spends no title width on an open PR whose wire omits the readiness field entirely', () => {
      // `pr_merge_readiness` became OPTIONAL in protocol 0.13.1, so a desktop
      // may leave the key off rather than send null. Every other undefined
      // case in this change is a literal handed straight to the presentation
      // helpers; this is the only one that travels the real production path,
      // reading an absent key off a BoardTaskWire inside the card.
      //
      // The key is DELETED rather than set to undefined on purpose: an
      // explicit `pr_merge_readiness: undefined` is not the same object shape
      // the wire produces, and `boardTaskFixture` defaults the field to null.
      // The `delete` below also only compiles because the field is optional,
      // so this line fails to build against 0.13.0.
      //
      // Unlike the undefined cases in tests/unit/prChipPresentation.test.ts,
      // this one IS falsifiable. Verified failing: resolving the undefined arm
      // of `presentationForReadiness` to the `ready` entry rendered a `ready`
      // label and turned this red on both platform projects at the
      // `queryByText('ready')` line, which is what proves the absent key
      // actually travels to the reader rather than being normalised somewhere
      // on the way in.
      //
      // The accessibilityLabel assertion covers the card's OTHER production
      // call site (`prChipAccessibilityLabel` at TaskCard.tsx:152), which the
      // rest of this block exercises but never asserts on. The shared-helper
      // mutation above cannot isolate this line: Jest stops at the first
      // failing assertion, and that mutation reddens `queryByText('ready')`
      // first. Verified failing with a mutation scoped to this call site
      // instead: making `prChipAccessibilityLabel`'s absent-verdict branch
      // return `'Pull request'` (rather than `'Pull request open'`) only when
      // `prMergeReadiness === undefined` left both `queryByText` assertions
      // green and reddened only this line - `Expected: "Pull request open" /
      // Received: "Pull request"` - which is what proves this assertion
      // carries coverage the two above it do not.
      const task = boardTaskFixture({ pr_number: 42, pr_state: 'open' });
      delete task.pr_merge_readiness;
      expect('pr_merge_readiness' in task).toBe(false);

      renderTaskCard({ task });

      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
      expect(screen.queryByText('open')).toBeNull();
      expect(screen.queryByText('ready')).toBeNull();
      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`).props.accessibilityLabel).toBe('Pull request open');
    });

    it('never shows a stale verdict on a merged PR', () => {
      // The desktop stops refreshing readiness once a PR lands, so this is
      // what the wire really looks like afterwards. Seen failing against a
      // mutation that consulted readiness outside the open branch.
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 103, pr_state: 'merged', pr_merge_readiness: 'ready' }),
      });

      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
      expect(screen.queryByText('ready')).toBeNull();
    });

    it('reaches a screen reader as its own node, carrying the freshness caveat', () => {
      // The Card around this is pressable, so an `accessible` View nested
      // inside it could have been collapsed into the card's own label. This
      // asserts the node actually resolves rather than assuming it does.
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: 'blocked' }),
      });

      expect(screen.getByLabelText(new RegExp(PR_READINESS_FRESHNESS_CAVEAT))).toBeTruthy();
    });
  });

  describe('label overflow', () => {
    const manyLabels = ['backend', 'notifications', 'migration', 'breaking-change', 'p0'];

    it('shows the fallback limit (3) before the labels row has been measured', () => {
      renderTaskCard({ task: boardTaskFixture({ labels: manyLabels }) });

      expect(screen.getByText('backend')).toBeTruthy();
      expect(screen.getByText('notifications')).toBeTruthy();
      expect(screen.getByText('migration')).toBeTruthy();
      expect(screen.queryByText('breaking-change')).toBeNull();
      expect(screen.queryByText('p0')).toBeNull();
      expect(screen.getByText('+2')).toBeTruthy();
    });

    it('recomputes the visible count once the labels row reports its real width', () => {
      renderTaskCard({ task: boardTaskFixture({ labels: manyLabels }) });

      const labelsRow = findAncestorWithLayoutHandler(screen.getByText('backend'));
      fireEvent(labelsRow, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 24 } } });

      // At 300px, computeVisibleLabelCount fits exactly 2 (see labelFit.test.ts).
      expect(screen.getByText('backend')).toBeTruthy();
      expect(screen.getByText('notifications')).toBeTruthy();
      expect(screen.queryByText('migration')).toBeNull();
      expect(screen.getByText('+3')).toBeTruthy();
    });
  });

  describe('the elapsed-wait label', () => {
    const MINUTE = 60_000;
    const BODY_HEIGHT = 32;

    /**
     * Outside a NowTickProvider `useNowTick` freezes at mount, so "now" is
     * whatever Date.now() returns during render. Fake timers pin it, which is
     * what lets these assert an exact string rather than a regex.
     */
    function renderWithWait(waitedMs: number | null): void {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
      renderTaskCard({
        bodyMinHeight: BODY_HEIGHT,
        bodyNumberOfLines: 2,
        waitingSinceMs: waitedMs === null ? null : Date.now() - waitedMs,
      });
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('renders how long the message beside it has been waiting', () => {
      renderWithWait(4 * 60 * MINUTE + 7 * MINUTE);
      expect(screen.getByTestId(`${BASE_TEST_ID}-wait`)).toHaveTextContent('4h 7m');
    });

    it('spells the span out for a screen reader, since "4h 7m" read alone says nothing', () => {
      renderWithWait(4 * 60 * MINUTE + 7 * MINUTE);
      expect(screen.getByTestId(`${BASE_TEST_ID}-wait`).props.accessibilityLabel).toBe('Waiting 4 hours 7 minutes');
    });

    /**
     * A row that has only just gone idle is not "waiting" in any sense the user
     * cares about, and a label blinking on at every turn boundary is exactly
     * the status filler the Agents feed deliberately has none of.
     */
    it('renders nothing at all below a minute - never "0m"', () => {
      renderWithWait(45_000);
      expect(screen.queryByTestId(`${BASE_TEST_ID}-wait`)).toBeNull();
      expect(screen.queryByText('0m')).toBeNull();
    });

    it('renders nothing for a working row, which passes null', () => {
      renderWithWait(null);
      expect(screen.queryByTestId(`${BASE_TEST_ID}-wait`)).toBeNull();
    });

    /**
     * The card's fixed body slot exists so a feed never moves under a reading
     * thumb. The wait label rides INSIDE that slot for the same reason, so
     * adding one must not change the reserved height - a label that pushed the
     * row taller would shift every card below it the moment a session crossed
     * a minute.
     */
    it('keeps the fixed body slot at exactly its reserved height', () => {
      renderWithWait(12 * MINUTE);
      const snippet = screen.getByTestId(`${BASE_TEST_ID}-snippet`);
      const slot = findAncestorWithHeight(snippet, BODY_HEIGHT);
      expect(slot).toBeTruthy();
    });

    /**
     * `styles.snippetText`'s `flex: 1` is the load-bearing half that makes the
     * snippet TRUNCATE instead of pushing the wait label off the card (RN
     * expands `flex: 1` to `flexGrow 1 / flexShrink 1 / flexBasis 0`, see the
     * comment on `styles.snippetText` in TaskCard.tsx). RNTL computes no flex
     * layout, so no rendering assertion can see the effect of removing this
     * style - a bug here is invisible in rendered output, so this pins the
     * mechanism directly instead: the style prop actually attached to the
     * snippet Text.
     */
    it('keeps the snippet flexible so it truncates instead of pushing the wait label off the card', () => {
      renderWithWait(12 * MINUTE);
      const snippet = screen.getByTestId(`${BASE_TEST_ID}-snippet`);
      const flattenedSnippetStyle = StyleSheet.flatten(snippet.props.style as StyleProp<TextStyle>);
      expect(flattenedSnippetStyle?.flex).toBe(1);
    });
  });
});

/** Walks up from a node to the ancestor whose style fixes the given height. */
function findAncestorWithHeight(instance: ReactTestInstance, height: number): ReactTestInstance | null {
  let currentInstance: ReactTestInstance | null = instance;
  while (currentInstance !== null) {
    const style: unknown = currentInstance.props.style;
    if (style !== null && typeof style === 'object' && (style as { height?: number }).height === height) {
      return currentInstance;
    }
    currentInstance = currentInstance.parent;
  }
  return null;
}
