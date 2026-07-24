import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactTestInstance } from 'react-test-renderer';
import { ThemeProvider } from '@/components';
import { TaskCard, type TaskCardProps } from '@/components/board/TaskCard';
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

  it('showMetaRow={false} suppresses the labels row and the PR icon - its only coverage, since no caller passes this yet', () => {
    renderTaskCard({
      task: boardTaskFixture({ pr_number: 42, labels: ['backend', 'p0'] }),
      showMetaRow: false,
    });

    expect(screen.queryByTestId(`${BASE_TEST_ID}-pr`)).toBeNull();
    expect(screen.queryByText('backend')).toBeNull();
    expect(screen.queryByText('p0')).toBeNull();
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
});
