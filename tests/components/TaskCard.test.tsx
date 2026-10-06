import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { StyleSheet, View, type StyleProp, type TextStyle } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { GitMerge, GitMergeConflict, GitPullRequest } from 'lucide-react-native';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { TaskCard, type TaskCardProps } from '@/components/board/TaskCard';
import { PR_READINESS_FRESHNESS_CAVEAT } from '@/components/board/prChipPresentation';
import { boardColumnFixture, boardTaskFixture, usageFixture } from '@/devsupport/desktopFixtures';

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
      columnStrip: {
        column: boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, icon: 'code' }),
        track: [{ columnId: 'lane-doing', name: 'Doing', color: '#3fb950', state: 'current' }],
        projectName: 'Kangentic Mobile',
      },
      bodyText: 'A live inbox-style snippet.',
    });

    expect(screen.getByTestId(`${BASE_TEST_ID}-pr`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-usage`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-column-project`)).toBeTruthy();
    expect(screen.getByTestId(`${BASE_TEST_ID}-column-icon`)).toBeTruthy();
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

  describe('the column strip (Agents only)', () => {
    it('draws no strip when the caller passes none - the Board, where the column is the page being viewed', () => {
      renderTaskCard();
      expect(screen.queryByTestId(`${BASE_TEST_ID}-column`)).toBeNull();
    });

    it('draws the strip, keyed off the card testID, when the Agents feed passes one', () => {
      renderTaskCard({
        columnStrip: {
          column: boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null }),
          track: [{ columnId: 'lane-doing', name: 'Doing', color: '#3fb950', state: 'current' }],
          projectName: 'Alpha',
        },
      });
      expect(screen.getByTestId(`${BASE_TEST_ID}-column`)).toBeTruthy();
      expect(screen.getByTestId(`${BASE_TEST_ID}-column-project`)).toHaveTextContent('Alpha');
      expect(screen.getByTestId(`${BASE_TEST_ID}-column-marker`)).toBeTruthy();
    });

    /**
     * The project moved from a pill in the title row into the band: the title
     * row is the board's, and the pill was taking characters from the title.
     * The project must appear exactly once, in the band.
     */
    it('names the project once, in the band, never as a title-row pill', () => {
      renderTaskCard({
        columnStrip: { column: boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null }), track: [], projectName: 'Alpha' },
      });
      expect(screen.getAllByText('Alpha')).toHaveLength(1);
      expect(screen.queryByTestId(`${BASE_TEST_ID}-project`)).toBeNull();
    });

    /**
     * The section-change pulse is an absolutely positioned overlay, and the
     * strip's fill is opaque: whichever renders later paints on top. Rendered
     * before the strip, the pulse would tint the whole card except its top
     * band - invisible in any static render, so this pins the sibling order.
     */
    it('paints the overlay after the strip, so the pulse tints the band too', () => {
      render(
        <ThemeProvider>
          <TaskCard
            testID={BASE_TEST_ID}
            task={boardTaskFixture()}
            statusKind={null}
            showTicketNumbers={false}
            usage={null}
            bodyText="A task worth doing."
            onPress={jest.fn()}
            columnStrip={{ column: boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null }), track: [], projectName: 'Alpha' }}
            overlay={<View testID="task-card-overlay" />}
          />
        </ThemeProvider>,
      );
      // Pre-order over the whole tree is render order, and neither node
      // contains the other, so a later index is a later-painted sibling branch.
      const renderOrder = screen.UNSAFE_root.findAll(() => true);
      const stripIndex = renderOrder.indexOf(screen.getByTestId(`${BASE_TEST_ID}-column`));
      const overlayIndex = renderOrder.indexOf(screen.getByTestId('task-card-overlay'));
      expect(stripIndex).toBeGreaterThanOrEqual(0);
      expect(overlayIndex).toBeGreaterThan(stripIndex);
    });

    it('still draws the band for an unlocated task, with no marker', () => {
      renderTaskCard({ columnStrip: { column: null, track: [], projectName: 'Alpha' } });
      expect(screen.getByTestId(`${BASE_TEST_ID}-column`)).toBeTruthy();
      expect(screen.queryByTestId(`${BASE_TEST_ID}-column-marker`)).toBeNull();
    });
  });

  describe('PR chip (icon only: shape is the state, color the verdict)', () => {
    /** The glyph drawn inside the chip's wrapper, by its lucide component type. */
    function prChipGlyph(glyphType: React.ComponentType): ReactTestInstance {
      return within(screen.getByTestId(`${BASE_TEST_ID}-pr`)).UNSAFE_getByType(glyphType);
    }

    it('draws the merge-conflict icon in the conflict color, and no word, for a conflicting open PR', () => {
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: 'conflicting' }),
      });

      expect(prChipGlyph(GitMergeConflict).props.color).toBe(darkTerminalTheme.colors.conflict);
      expect(screen.queryByText('conflicts')).toBeNull();
    });

    it('draws the ready verdict as the PR icon in green, and no word', () => {
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: 'ready' }),
      });

      expect(prChipGlyph(GitPullRequest).props.color).toBe(darkTerminalTheme.colors.success);
      expect(screen.queryByText('ready')).toBeNull();
    });

    it('draws an open PR with no verdict in the quiet secondary color, so green can only mean ready', () => {
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 42, pr_state: 'open', pr_merge_readiness: null }),
      });

      expect(prChipGlyph(GitPullRequest).props.color).toBe(darkTerminalTheme.colors.textSecondary);
      expect(screen.queryByText('open')).toBeNull();
    });

    it('reads an open PR whose wire omits the readiness field entirely as plain open', () => {
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
      // this one IS falsifiable: resolving the undefined arm of
      // `presentationForReadiness` to the `ready` entry paints this chip green,
      // which the color assertion catches. That is what proves the absent key
      // actually travels to the reader rather than being normalised somewhere
      // on the way in.
      //
      // The accessibilityLabel assertion covers the card's OTHER production
      // call site (`prChipAccessibilityLabel`), which the rest of this block
      // exercises but never asserts on. Making that function's absent-verdict
      // branch return `'Pull request'` only when `prMergeReadiness ===
      // undefined` leaves the color green-free and reddens only this line.
      const task = boardTaskFixture({ pr_number: 42, pr_state: 'open' });
      delete task.pr_merge_readiness;
      expect('pr_merge_readiness' in task).toBe(false);

      renderTaskCard({ task });

      expect(prChipGlyph(GitPullRequest).props.color).toBe(darkTerminalTheme.colors.textSecondary);
      expect(screen.getByTestId(`${BASE_TEST_ID}-pr`).props.accessibilityLabel).toBe('Pull request open');
    });

    it('never shows a stale verdict on a merged PR: the merge icon, never the ready green', () => {
      // The desktop stops refreshing readiness once a PR lands, so this is
      // what the wire really looks like afterwards.
      renderTaskCard({
        task: boardTaskFixture({ pr_number: 103, pr_state: 'merged', pr_merge_readiness: 'ready' }),
      });

      expect(prChipGlyph(GitMerge).props.color).toBe(darkTerminalTheme.colors.info);
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
