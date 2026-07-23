import { getColumnIcon } from '@/components/board/columnIcons';

/**
 * getColumnIcon builds its registry from the real lucide-react-native module
 * (Object.entries over every named export), which transitively imports
 * react-native-svg -> react-native. That chain only loads under a React
 * Native transform (jest-expo's babel preset handles the Flow syntax in
 * react-native's source); vitest's plain Node environment cannot parse it.
 * So this lives in the Jest (Component) tier even though it renders nothing -
 * no ThemeProvider, no RNTL render, just the exported function against the
 * real icon set.
 */
function isComponent(value: unknown): boolean {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);
}

describe('getColumnIcon', () => {
  it('resolves an explicit valid icon name to a component', () => {
    const resolved = getColumnIcon({ icon: 'git-branch', role: null });
    expect(resolved).not.toBeNull();
    expect(isComponent(resolved)).toBe(true);
  });

  it('an explicit valid icon wins over the role default', () => {
    const explicitIcon = getColumnIcon({ icon: 'git-branch', role: 'todo' });
    const roleDefaultIcon = getColumnIcon({ icon: null, role: 'todo' });
    expect(explicitIcon).not.toBeNull();
    expect(explicitIcon).not.toBe(roleDefaultIcon);
  });

  it('an unknown icon name falls through to the role default', () => {
    const unknownIcon = getColumnIcon({ icon: 'not-a-real-icon', role: 'todo' });
    const roleDefaultIcon = getColumnIcon({ icon: null, role: 'todo' });
    expect(unknownIcon).not.toBeNull();
    expect(unknownIcon).toBe(roleDefaultIcon);
  });

  it('the todo and done role defaults each resolve non-null and differ from each other', () => {
    const todoDefaultIcon = getColumnIcon({ icon: null, role: 'todo' });
    const doneDefaultIcon = getColumnIcon({ icon: null, role: 'done' });
    expect(todoDefaultIcon).not.toBeNull();
    expect(doneDefaultIcon).not.toBeNull();
    expect(todoDefaultIcon).not.toBe(doneDefaultIcon);
  });

  it('resolves to null with no icon and no role', () => {
    expect(getColumnIcon({ icon: null, role: null })).toBeNull();
  });

  it('resolves to null for an unknown role', () => {
    expect(getColumnIcon({ icon: null, role: 'custom-role' })).toBeNull();
  });

  it('excludes the non-glyph exports (Icon, createLucideIcon, useLucideContext) instead of resolving them as bogus icons', () => {
    expect(getColumnIcon({ icon: 'icon', role: null })).toBeNull();
    expect(getColumnIcon({ icon: 'create-lucide-icon', role: null })).toBeNull();
    expect(getColumnIcon({ icon: 'use-lucide-context', role: null })).toBeNull();
  });
});
