import React from 'react';
import { SvgXml } from 'react-native-svg';
import {
  brandmarkMonoAmberXml,
  brandmarkMonoXml,
  brandmarkSmallXml,
  brandmarkXml,
} from '@/brand/brandmarkXml.generated';
import { useTheme } from '../theme/ThemeProvider';

/**
 * - `themed` (default): the mono-amber mark; the circle and letterform take
 *   the tint via currentColor and the K-notch stays brand amber.
 * - `mono`: the fully single-color mark, entirely tinted via currentColor.
 * - `full`: the full-color rust/amber mark; below the small-mark tier it
 *   swaps to the simplified brandmark-small so fine detail never muddies.
 */
export type BrandmarkVariant = 'themed' | 'mono' | 'full';

export interface BrandmarkProps {
  /** Rendered width and height in dp (the mark is square). */
  size: number;
  variant?: BrandmarkVariant;
  /**
   * Tint for the currentColor variants (`themed`, `mono`). Pass a theme
   * token value; defaults to the theme's primary text color. Ignored by
   * `full`, which carries its own brand colors.
   */
  color?: string;
  testID?: string;
}

/**
 * Below this displayed size the detailed brandmark's letterform detail is
 * illegible, so the `full` variant drops to the simplified small mark (the
 * brand package's displayed-size rule).
 */
const SMALL_MARK_MAX_SIZE_DP = 64;

/** The Kangentic brandmark as inline SVG from the generated brand assets. */
export function Brandmark({ size, variant = 'themed', color, testID = 'brandmark' }: BrandmarkProps): React.JSX.Element {
  const theme = useTheme();
  const tint = color ?? theme.colors.textPrimary;

  let xml: string;
  switch (variant) {
    case 'themed':
      xml = brandmarkMonoAmberXml;
      break;
    case 'mono':
      xml = brandmarkMonoXml;
      break;
    case 'full':
      xml = size < SMALL_MARK_MAX_SIZE_DP ? brandmarkSmallXml : brandmarkXml;
      break;
  }

  return <SvgXml testID={testID} xml={xml} width={size} height={size} color={tint} />;
}
