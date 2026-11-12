import { describe, expect, it } from 'vitest';
import { BOARD_TASK_ARTIFACTS_WIRE_MAX, type BoardTaskArtifactWire } from '@kangentic/protocol';
import { ARTIFACT_NAME_MAX_LENGTH, artifactNamesCaption, openableArtifacts } from '../../src/lib/taskArtifacts';

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

  it('strips www and port from the host and lowercases it', () => {
    const links = openableArtifacts([artifact('https://WWW.Figma.com/file/1', 'a'), artifact('https://example.com:8443/x', 'b')]);
    expect(links.map((link) => link.host)).toEqual(['figma.com', 'example.com']);
  });

  // The caption is the one line the phone derives itself, and a person taps on
  // the strength of it. Each of these authorities is one the OS openers read
  // differently from a string split (WHATWG reads `\` as `/`, so Chrome opens
  // evil.example while the caption would say trusted.example), so the link is
  // left out rather than drawn under a host it may not open.
  it('drops a link whose authority an opener could read as another host', () => {
    const links = openableArtifacts([
      artifact('https://evil.example\\@trusted.example/x', 'Backslash decoy'),
      artifact('https://user:pw@claude.ai/chat', 'Userinfo'),
      artifact('https://exa\tmple.com/x', 'Tab'),
      artifact('https://exa mple.com/x', 'Space'),
      artifact('https://example.com\u0000/x', 'Control'),
    ]);
    expect(links).toEqual([]);
  });

  it('keeps an @ or a backslash that sits past the authority', () => {
    const links = openableArtifacts([artifact('https://example.com/people/@someone', 'At'), artifact('https://example.com/a\\b', 'Slash')]);
    expect(links.map((link) => link.host)).toEqual(['example.com', 'example.com']);
  });

  it('drops a link with no host to show', () => {
    expect(openableArtifacts([artifact('https:///path', 'No host'), artifact('https://:8443/x', 'Port only')])).toEqual([]);
  });

  it('keeps at most the protocol limit of links, in order', () => {
    const many = Array.from({ length: BOARD_TASK_ARTIFACTS_WIRE_MAX + 5 }, (_, index) => artifact(`https://example.com/${index}`, `Link ${index}`));
    const links = openableArtifacts(many);
    expect(links).toHaveLength(BOARD_TASK_ARTIFACTS_WIRE_MAX);
    expect(links[0].name).toBe('Link 0');
    expect(links[BOARD_TASK_ARTIFACTS_WIRE_MAX - 1].name).toBe(`Link ${BOARD_TASK_ARTIFACTS_WIRE_MAX - 1}`);
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
