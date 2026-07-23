import * as LucideIcons from 'lucide-react-native';
import type { LucideIcon } from 'lucide-react-native';
import type { BoardColumnWire } from '@kangentic/protocol';

/** PascalCase -> kebab-case, mirroring the desktop icon picker's own naming (e.g. GitBranch -> git-branch). */
function toKebabCase(exportName: string): string {
  return exportName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * The module's non-glyph exports. `Icon` is lucide's generic renderer (it
 * needs an `iconNode` prop, so rendering it as a plain glyph throws), and
 * the other two are a factory and a hook. They survive kebab-casing into
 * real-looking keys ('icon', 'create-lucide-icon', 'use-lucide-context'),
 * so they are excluded rather than left as a crash a desktop-authored icon
 * name could reach.
 */
const NON_GLYPH_EXPORT_NAMES = new Set(['Icon', 'createLucideIcon', 'useLucideContext']);

/** Glyph components are the PascalCase exports; the rest are helpers. */
function isGlyphExport(exportName: string): boolean {
  return !NON_GLYPH_EXPORT_NAMES.has(exportName) && /^[A-Z]/.test(exportName);
}

/**
 * Every lucide glyph, keyed by the same kebab-case name the desktop's icon
 * picker writes into `BoardColumnWire.icon` (the desktop's
 * src/renderer/utils/swimlane-icons.tsx). Built once from the full icon set
 * rather than a hand-maintained table, so it can never drift from whatever
 * lucide-react-native ships - unlike the closed registry in Icon.tsx, this
 * is arbitrary desktop-authored data, not a fixed in-app glyph set, so the
 * non-glyph exports are filtered out instead of trusted.
 */
const ICON_REGISTRY: Map<string, LucideIcon> = new Map(
  Object.entries(LucideIcons)
    .filter(([exportName]) => isGlyphExport(exportName))
    .map(([exportName, component]) => [toKebabCase(exportName), component as LucideIcon]),
);

/**
 * Default glyphs for the two system column roles, matching the desktop's
 * ROLE_DEFAULTS - an untouched "To Do"/"Done" column (no explicit icon
 * picked) still shows an icon instead of reading as unset.
 */
const ROLE_DEFAULT_ICON_NAMES: Record<string, string> = {
  todo: 'layers',
  done: 'circle-check-big',
};

/**
 * Resolve a column's icon: an explicit user-picked icon first, then the
 * role default, then null (the color-dot fallback) - the exact priority
 * order as the desktop's getSwimlaneIcon, so mobile and desktop agree on
 * what a column "looks like".
 */
export function getColumnIcon(column: Pick<BoardColumnWire, 'icon' | 'role'>): LucideIcon | null {
  if (column.icon !== null) {
    const custom = ICON_REGISTRY.get(column.icon);
    if (custom) return custom;
  }
  if (column.role !== null) {
    const roleDefaultName = ROLE_DEFAULT_ICON_NAMES[column.role];
    if (roleDefaultName !== undefined) return ICON_REGISTRY.get(roleDefaultName) ?? null;
  }
  return null;
}
