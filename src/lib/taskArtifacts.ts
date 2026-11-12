import { BOARD_TASK_ARTIFACTS_WIRE_MAX, type BoardTaskArtifactWire } from '@kangentic/protocol';
import { httpsUrlOrNull } from './httpsUrl';

/**
 * The longest artifact name drawn. The name is peer-supplied display text (the
 * desktop resolves it from the stored name or the link itself), so it is capped
 * here and the row's single line truncates what is left.
 */
export const ARTIFACT_NAME_MAX_LENGTH = 120;

/** One of a task's links as the phone draws it: an https link, its name, and the site it lives on. */
export interface TaskArtifactLink {
  url: string;
  name: string;
  /** The link's host, without `www.`, where the desktop shows the tool's name (figma.com, claude.ai). */
  host: string;
}

/**
 * Whether an authority holds a character the OS openers disagree on: a `user@`
 * part, a backslash (the WHATWG parser behind Chrome reads it as `/`, Android's
 * `Uri` and a string split do not), or whitespace and control characters. For
 * `https://evil.example\@trusted.example` a split reads trusted.example while
 * Chrome opens evil.example, so a caption drawn from it would name a site the
 * tap does not go to.
 */
function isAmbiguousAuthority(authority: string): boolean {
  for (const character of authority) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || character === '@' || character === '\\') return true;
  }
  return /\s/.test(authority);
}

/**
 * The host of an https URL, by string, for the reason `httpsUrlOrNull` gives
 * (Hermes' partial URL implementation). Drops any port and `www.`. Null when
 * there is no host to show, or the authority is one an opener could read as a
 * different host (`isAmbiguousAuthority`): the caption is the one line the
 * phone derives itself, and a person taps on the strength of it.
 */
function hostOf(httpsUrl: string): string | null {
  const afterScheme = httpsUrl.slice('https://'.length);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  if (isAmbiguousAuthority(authority)) return null;
  const host = authority.replace(/:\d+$/, '').replace(/^www\./i, '').toLowerCase();
  return host.length > 0 ? host : null;
}

/**
 * A task's links that the phone may open (protocol 0.28.0), in the desktop's
 * order. Only https ones: the link is untrusted task text, and only an https
 * link is handed to the OS opener, as Chat's links are (`httpsUrlOrNull`). A
 * link that is not https, or whose host cannot be shown truthfully, is left out
 * rather than drawn as a row that refuses or misleads. At most the protocol's
 * `BOARD_TASK_ARTIFACTS_WIRE_MAX`, which the parser does not enforce itself, so
 * the Artifacts sheet's list stays as short as its comment says. Null or absent
 * on the row (an older desktop) reads as none.
 */
export function openableArtifacts(artifacts: readonly BoardTaskArtifactWire[] | null | undefined): TaskArtifactLink[] {
  if (!artifacts) return [];
  return artifacts.slice(0, BOARD_TASK_ARTIFACTS_WIRE_MAX).flatMap((artifact): TaskArtifactLink[] => {
    const url = httpsUrlOrNull(artifact.url);
    if (url === null) return [];
    const host = hostOf(url);
    if (host === null) return [];
    const trimmedName = artifact.name.trim();
    const name = (trimmedName.length > 0 ? trimmedName : host).slice(0, ARTIFACT_NAME_MAX_LENGTH);
    return [{ url, name, host }];
  });
}

/** The several-links row's caption: every name, comma separated, for its one truncating line. */
export function artifactNamesCaption(links: readonly TaskArtifactLink[]): string {
  return links.map((link) => link.name).join(', ');
}
