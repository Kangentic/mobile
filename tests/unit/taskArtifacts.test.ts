import { describe, expect, it } from 'vitest';
import type { BoardTaskArtifactWire } from '@kangentic/protocol';
import { ARTIFACT_NAME_MAX_LENGTH, artifactCountLabel, artifactNamesCaption, openableArtifacts } from '../../src/lib/taskArtifacts';

function artifact(url: string, name: string): BoardTaskArtifactWire {
  return { url, name } as BoardTaskArtifactWire;
}

describe('openableArtifacts', () => {
  it('reads absent as none', () => {
    expect(openableArtifacts(null)).toEqual([]);
    expect(openableArtifacts(undefined)).toEqual([]);
  });

  it('drops anything that is not a usable https link', () => {
    const links = openableArtifacts([
      artifact('http://example.com/a', 'Plain http'),
      artifact('javascript:alert(1)', 'Script'),
      artifact('kangentic://pair', 'Scheme'),
      artifact('https://', 'Empty'),
      artifact('https://example.com/ok', 'Kept'),
    ]);
    expect(links.map((link) => link.name)).toEqual(['Kept']);
  });

  it('keeps the desktop order', () => {
    const links = openableArtifacts([artifact('https://b.example.com', 'B'), artifact('https://a.example.com', 'A')]);
    expect(links.map((link) => link.name)).toEqual(['B', 'A']);
  });

  it('strips www, port and userinfo from the host and lowercases it', () => {
    const links = openableArtifacts([
      artifact('https://WWW.Figma.com/file/1', 'a'),
      artifact('https://example.com:8443/x', 'b'),
      artifact('https://user:pw@Claude.AI/chat', 'c'),
    ]);
    expect(links.map((link) => link.host)).toEqual(['figma.com', 'example.com', 'claude.ai']);
  });

  it('falls back to the host when the name is blank', () => {
    expect(openableArtifacts([artifact('https://www.figma.com/file/1', '   ')])[0].name).toBe('figma.com');
  });

  it('caps the name', () => {
    const long = 'x'.repeat(ARTIFACT_NAME_MAX_LENGTH + 50);
    expect(openableArtifacts([artifact('https://example.com', long)])[0].name).toHaveLength(ARTIFACT_NAME_MAX_LENGTH);
  });
});

describe('artifactNamesCaption', () => {
  it('joins the names with a comma and space', () => {
    const links = openableArtifacts([artifact('https://a.com', 'A'), artifact('https://b.com', 'B')]);
    expect(artifactNamesCaption(links)).toBe('A, B');
  });
});

describe('artifactCountLabel', () => {
  it('is singular for one and plural otherwise', () => {
    expect(artifactCountLabel(1)).toBe('1 artifact');
    expect(artifactCountLabel(3)).toBe('3 artifacts');
  });
});
