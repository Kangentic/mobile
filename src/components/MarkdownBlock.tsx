import React, { useMemo } from 'react';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/tokens';

export interface MarkdownBlockProps {
  markdown: string;
  testID?: string;
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
 *   enables by default. Rendering stays what it was on 0.7.x, the APK skips
 *   Media3 ExoPlayer, and the postinstall exits without downloading the
 *   tree-sitter grammars or the RaTeX framework.
 * - 1.1.0 removes its accessibility layout listener on detach (upstream #731).
 *   That listener retained a whole session screen per open on 0.7.x, which is
 *   what the deleted patch-package patch used to fix (REACT-NATIVE-5 in
 *   docs/developer-guide.md).
 * - Styling flows through the `markdownStyle` prop, mapped below from the
 *   theme's semantic tokens and typography scale.
 */
export function MarkdownBlock({ markdown, testID }: MarkdownBlockProps): React.JSX.Element {
  const theme = useTheme();
  const markdownStyle = useMemo(() => markdownStyleFromTheme(theme), [theme]);

  // Retention bisect: keeps the native view, drops the selectable TextView.
  const selectable = getRetentionProbeVariant() !== 'markdown-not-selectable';

  return (
    <EnrichedMarkdownText
      testID={testID}
      markdown={markdown}
      markdownStyle={markdownStyle}
      selectable={selectable}
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
  };
}
