import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import type { ReadBoardProjectSummary } from '@kangentic/protocol';
import { AgentStatusIcon, Stack, Text, TextField, useTheme } from '@/components';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';

/** Above this many projects the list gets a filter field; below it, scanning is faster than typing. */
const SEARCH_THRESHOLD = 8;
/** Keeps a long list inside the sheet instead of growing it past the screen. */
const LIST_MAX_HEIGHT = 420;

interface ProjectAgentCounts {
  needsYou: number;
  working: number;
}

/**
 * Which project the Board tab shows, as a native form sheet route.
 *
 * The selection lands in the board store rather than being handed back
 * through a callback: a route has no parent to call. BoardScreen reacts to
 * the store, which also lets it reset the visible column itself instead of
 * the picker reaching across to do it.
 *
 * Each row carries its project's live agent status, which is the reason to
 * open this sheet at all: on a phone the question is usually "which project
 * wants me", and answering it by switching into each board in turn is the
 * slow way round. The counts cost nothing extra on the wire - the feed
 * already watches every project's sessions.
 */
export function ProjectPickerScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const projects = useBoardStore((state) => state.projects);
  const selectedProjectId = useBoardStore((state) => state.selectedProjectId);
  const selectProject = useBoardStore((state) => state.selectProject);
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  const projectGroups = useBoardStore((state) => state.projectGroups);
  const bySessionId = useActivityStore((state) => state.bySessionId);
  const [query, setQuery] = useState('');
  const currentProjectId = selectedProjectId ?? projects[0]?.id ?? null;

  /**
   * Per-project agent counts, resolved session -> task -> project.
   *
   * Built once per store change rather than per row: the session map is
   * walked once here instead of once for every project on every render.
   */
  const countsByProjectId = useMemo(() => {
    const taskProjectId = new Map<string, string>();
    for (const [projectId, board] of Object.entries(boardsByProjectId)) {
      for (const taskId of Object.keys(board.tasksById)) taskProjectId.set(taskId, projectId);
    }
    const counts = new Map<string, ProjectAgentCounts>();
    for (const entry of Object.values(bySessionId)) {
      const projectId = entry.taskId === null ? undefined : taskProjectId.get(entry.taskId);
      if (projectId === undefined) continue;
      const current = counts.get(projectId) ?? { needsYou: 0, working: 0 };
      const section = sectionForEntry(entry);
      if (section === 'needs-you' || entry.awaitedPromptId !== null) current.needsYou += 1;
      else if (section === 'working') current.working += 1;
      counts.set(projectId, current);
    }
    return counts;
  }, [boardsByProjectId, bySessionId]);

  const showSearch = projects.length > SEARCH_THRESHOLD;
  const visibleProjects = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed.length === 0) return projects;
    return projects.filter((project) => project.name.toLowerCase().includes(trimmed));
  }, [projects, query]);

  /**
   * The visible projects arranged into the desktop's own groups.
   *
   * A pre-0.11.0 desktop sends no groups and every project falls into the
   * ungrouped bucket, which renders as the flat list this screen always was.
   * Ungrouped projects sort last, matching the desktop sidebar.
   */
  const sections = useMemo(() => {
    const byGroupId = new Map<string | null, ReadBoardProjectSummary[]>();
    for (const project of visibleProjects) {
      const key = project.groupId ?? null;
      const bucket = byGroupId.get(key);
      if (bucket) bucket.push(project);
      else byGroupId.set(key, [project]);
    }
    for (const bucket of byGroupId.values()) {
      bucket.sort((first, second) => (first.position ?? 0) - (second.position ?? 0));
    }
    const grouped = [...projectGroups]
      .sort((first, second) => first.position - second.position)
      .flatMap((group) => {
        const members = byGroupId.get(group.id) ?? [];
        // A group whose every project is filtered out disappears with them,
        // rather than leaving a header over nothing.
        return members.length > 0 ? [{ id: group.id, title: group.name, projects: members }] : [];
      });
    // A project whose groupId matches no known group joins the ungrouped
    // bucket rather than vanishing: the groups list and the project list are
    // two separate desktop reads, so they can legitimately arrive out of step,
    // and dropping the project would make a paired project unreachable from
    // the only screen that can switch to it.
    const knownGroupIds = new Set(projectGroups.map((group) => group.id));
    // Re-sorted after the concatenation, not just within each bucket: the
    // buckets were sorted individually above, so joining them would otherwise
    // interleave by Map insertion order and show position 5 above position 1.
    const ungrouped = [...byGroupId.entries()]
      .filter(([groupId]) => groupId === null || !knownGroupIds.has(groupId))
      .flatMap(([, members]) => members)
      .sort((first, second) => (first.position ?? 0) - (second.position ?? 0));
    return ungrouped.length > 0
      ? [...grouped, { id: '__ungrouped__', title: grouped.length > 0 ? 'Ungrouped' : null, projects: ungrouped }]
      : grouped;
  }, [visibleProjects, projectGroups]);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.xl + insets.bottom,
        },
      ]}
      testID="board-project-sheet"
    >
      <Stack gap="sm">
        <Text variant="title">Projects</Text>

        {showSearch ? (
          <TextField
            value={query}
            onChangeText={setQuery}
            placeholder="Filter projects"
            testID="board-project-search"
            autoCorrect={false}
            autoCapitalize="none"
          />
        ) : null}

        {/* handled, not never: the rows are tappable while the filter field
            holds the keyboard, and the default would spend the first tap
            dismissing it. */}
        <ScrollView
          style={{ maxHeight: LIST_MAX_HEIGHT }}
          keyboardShouldPersistTaps="handled"
          testID="board-project-list"
        >
          {visibleProjects.length === 0 ? (
            <View style={{ paddingVertical: theme.spacing.md }}>
              <Text color="muted">No project matches that.</Text>
            </View>
          ) : (
            sections.map((section) => (
              <View key={section.id}>
                {section.title !== null ? (
                  <View style={{ paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xs, paddingHorizontal: theme.spacing.md }}>
                    <Text variant="caption" color="muted" style={styles.groupTitle}>
                      {section.title}
                    </Text>
                  </View>
                ) : null}
                {section.projects.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    counts={countsByProjectId.get(project.id) ?? null}
                    selected={project.id === currentProjectId}
                    onSelect={() => {
                      selectProject(project.id);
                      router.back();
                    }}
                  />
                ))}
              </View>
            ))
          )}
        </ScrollView>
      </Stack>
    </View>
  );
}

function ProjectRow({
  project,
  counts,
  selected,
  onSelect,
}: {
  project: ReadBoardProjectSummary;
  counts: ProjectAgentCounts | null;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      testID={`board-project-${project.id}`}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={buildAccessibilityLabel(project.name, counts, selected)}
      onPress={onSelect}
      style={[
        styles.row,
        {
          minHeight: theme.minTouchSize,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radii.md,
          backgroundColor: selected ? theme.colors.accentSubtle : 'transparent',
        },
      ]}
    >
      {/* Reserves the tick's width on every row so names stay aligned rather
          than shifting sideways as the selection moves. */}
      <View style={styles.tick}>
        {selected ? <Check size={16} color={theme.colors.accent} strokeWidth={2.4} /> : null}
      </View>

      <Text variant="body" color={selected ? 'primary' : 'secondary'} numberOfLines={1} style={styles.name}>
        {project.name}
      </Text>

      {counts !== null && counts.needsYou > 0 ? (
        <View style={styles.status}>
          <AgentStatusIcon kind="idle-unread" size={15} />
          <Text variant="caption" color="accent">{String(counts.needsYou)}</Text>
        </View>
      ) : null}
      {counts !== null && counts.working > 0 ? (
        <View style={styles.status}>
          <AgentStatusIcon kind="working" size={15} />
          <Text variant="caption" color="muted">{String(counts.working)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Screen readers get the counts spelled out; the visual rows carry them as icon plus number. */
function buildAccessibilityLabel(name: string, counts: ProjectAgentCounts | null, selected: boolean): string {
  const parts = [name];
  if (selected) parts.push('current project');
  if (counts !== null && counts.needsYou > 0) parts.push(`${counts.needsYou} needing you`);
  if (counts !== null && counts.working > 0) parts.push(`${counts.working} working`);
  return parts.join(', ');
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  name: {
    flex: 1,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  status: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 4,
  },
  groupTitle: {
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  tick: {
    alignItems: 'center',
    width: 18,
  },
});
