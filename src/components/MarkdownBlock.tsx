import React, { useMemo } from 'react';
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown';
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
 * Library notes (react-native-enriched-markdown 0.7.x):
 * - Renders via `EnrichedMarkdownText`, a native Fabric component (New
 *   Architecture required). It needs a native rebuild (`npx expo prebuild` /
 *   a new dev client) and does not run in Expo Go.
 * - Autolinking is sufficient; its optional Expo config plugin
 *   (`react-native-enriched-markdown/app.plugin.js`) only toggles the LaTeX
 *   math native dependency (`{ enableMath: boolean }`), which we do not need.
 * - Styling flows through the `markdownStyle` prop, mapped below from the
 *   theme's semantic tokens and typography scale.
 */
export function MarkdownBlock({ markdown, testID }: MarkdownBlockProps): React.JSX.Element {
  const theme = useTheme();
  const markdownStyle = useMemo(() => markdownStyleFromTheme(theme), [theme]);

  return <EnrichedMarkdownText testID={testID} markdown={markdown} markdownStyle={markdownStyle} />;
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
