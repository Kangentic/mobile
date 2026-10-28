import React, { useCallback, useMemo } from 'react';
import * as Linking from 'expo-linking';
import { EnrichedMarkdownText, type LinkPressEvent, type MarkdownStyle } from 'react-native-enriched-markdown';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';
import { httpsUrlOrNull } from '@/lib/httpsUrl';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/tokens';

/**
 * `commonmark` is the library's single-TextView renderer and every surface's
 * default. `github` is its container-based GFM renderer, the only one that
 * draws task-list checkboxes (`- [ ]`); a completed task's Description uses it
 * to match the desktop, and nothing else does until it is measured there.
 */
export type MarkdownFlavor = 'commonmark' | 'github';

export interface MarkdownBlockProps {
  markdown: string;
  testID?: string;
  flavor?: MarkdownFlavor;
}

/**
 * The single swap-point adapter for markdown rendering. Every
 * react-native-enriched-markdown import stays inside this file, so replacing
 * the markdown library is a one-file change: keep the `MarkdownBlockProps`
 * contract and rewrite the body.
 *
 * Library notes (react-native-enriched-markdown 1.1.x):
 * - Renders via `EnrichedMarkdownText`, a native Fabric component (New
 *   Architecture required). It needs a native rebuild (`npx expo prebuild` /
 *   a new dev client) and does not run in Expo Go.
 * - Autolinking is sufficient. 1.0.2 removed the bundled Expo config plugin;
 *   native features are configured by the `"enriched-markdown"` block in
 *   package.json, which both the Gradle build and the podspec read.
 * - That block turns OFF math, code highlighting and video, all of which 1.x
 *   enables by default. Highlighting and video are new in 1.x, so code blocks
 *   render as they did on 0.7.x. Math is NOT: 0.7.4 rendered LaTeX through
 *   RaTeX (libratex_ffi.so plus the KaTeX fonts, about 3 MB of APK), and it is
 *   off now by decision (task #102), so `$...$` in a transcript shows as the
 *   literal source text. With all three off the APK skips Media3 ExoPlayer,
 *   and the postinstall exits without downloading the tree-sitter grammars or
 *   the RaTeX framework.
 * - 1.1.0 removes its accessibility layout listener on detach (upstream #731).
 *   That listener retained a whole session screen per open on 0.7.x, which is
 *   what the deleted patch-package patch used to fix (REACT-NATIVE-5 in
 *   docs/developer-guide.md).
 * - Styling flows through the `markdownStyle` prop, mapped below from the
 *   theme's semantic tokens and typography scale.
 * - The library never opens a URL itself: a tapped link only reaches
 *   `onLinkPress` (Android's `LinkSpan.onClick`, iOS's
 *   `ENRMTextInteractionUtils.m`), and with no handler the tap goes nowhere.
 *   This adapter opens it, https only, because link URLs are agent-authored.
 *   No `onLinkLongPress`, so iOS keeps its system link preview.
 */
export function MarkdownBlock({ markdown, testID, flavor = 'commonmark' }: MarkdownBlockProps): React.JSX.Element {
  const theme = useTheme();
  const markdownStyle = useMemo(() => markdownStyleFromTheme(theme), [theme]);

  // Retention bisect: keeps the native view, drops the selectable TextView.
  const selectable = getRetentionProbeVariant() !== 'markdown-not-selectable';

  /**
   * `Linking.openURL` hands the URL to the OS default handler, so a github.com
   * link opens in the GitHub app where it is installed, as the task actions
   * sheet's View pull request does. Anything that is not https is ignored
   * (see `httpsUrlOrNull`). A refusal is dropped: a markdown block has no
   * error surface, and the tap simply does nothing, as it did before.
   */
  const onLinkPress = useCallback((event: LinkPressEvent) => {
    const url = httpsUrlOrNull(event.url);
    if (url === null) return;
    void Linking.openURL(url).catch((error: unknown) => {
      if (__DEV__) console.warn('[markdown] could not open link:', error);
    });
  }, []);

  return (
    <EnrichedMarkdownText
      testID={testID}
      markdown={markdown}
      markdownStyle={markdownStyle}
      selectable={selectable}
      onLinkPress={onLinkPress}
      flavor={flavor}
      // A checkbox here is read-only: a local toggle would never reach the
      // desktop's description. Only the GitHub flavor draws one.
      enableTaskListItemToggle={false}
    />
  );
}

function markdownStyleFromTheme(theme: Theme): MarkdownStyle {
  const bodyText = {
    fontSize: theme.typography.body.fontSize,
    lineHeight: theme.typography.body.lineHeight,
    color: theme.colors.textPrimary,
  };

  return {
    paragraph: {
      ...bodyText,
      marginTop: theme.spacing.xs,
      marginBottom: theme.spacing.xs,
    },
    h1: {
      fontSize: theme.typography.heading.fontSize,
      lineHeight: theme.typography.heading.lineHeight,
      fontWeight: theme.typography.heading.fontWeight,
      color: theme.colors.textPrimary,
    },
    h2: {
      fontSize: theme.typography.title.fontSize,
      lineHeight: theme.typography.title.lineHeight,
      fontWeight: theme.typography.title.fontWeight,
      color: theme.colors.textPrimary,
    },
    h3: {
      fontSize: theme.typography.bodyStrong.fontSize,
      lineHeight: theme.typography.bodyStrong.lineHeight,
      fontWeight: theme.typography.bodyStrong.fontWeight,
      color: theme.colors.textPrimary,
    },
    h4: { ...bodyText, fontWeight: theme.typography.bodyStrong.fontWeight },
    h5: { ...bodyText, fontWeight: theme.typography.bodyStrong.fontWeight },
    h6: { ...bodyText, fontWeight: theme.typography.bodyStrong.fontWeight },
    blockquote: {
      ...bodyText,
      color: theme.colors.textSecondary,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface,
    },
    list: {
      ...bodyText,
      bulletColor: theme.colors.textSecondary,
      markerColor: theme.colors.textSecondary,
    },
    codeBlock: {
      fontFamily: theme.fontFamilyMono,
      fontSize: theme.typography.caption.fontSize,
      lineHeight: theme.typography.caption.lineHeight,
      color: theme.colors.textPrimary,
      backgroundColor: theme.colors.codeBackground,
      borderColor: theme.colors.border,
      borderRadius: theme.radii.sm,
      padding: theme.spacing.sm,
    },
    // Inline code: no fontSize override so it inherits the surrounding text size.
    code: {
      fontFamily: theme.fontFamilyMono,
      color: theme.colors.textPrimary,
      backgroundColor: theme.colors.codeBackground,
      borderColor: theme.colors.border,
    },
    link: {
      color: theme.colors.accent,
      underline: true,
    },
    thematicBreak: {
      color: theme.colors.border,
    },
    table: {
      ...bodyText,
      headerBackgroundColor: theme.colors.surfaceRaised,
      headerTextColor: theme.colors.textPrimary,
      borderColor: theme.colors.border,
    },
    // GitHub flavor only: read-only checkboxes in the list markers' color, a
    // checked item left legible rather than struck through.
    taskList: {
      borderColor: theme.colors.textSecondary,
      checkedColor: theme.colors.textSecondary,
      checkmarkColor: theme.colors.background,
      checkedTextColor: theme.colors.textPrimary,
      checkedStrikethrough: false,
      checkboxBorderRadius: theme.radii.sm,
    },
  };
}
