import type { BoardTaskArtifactWire } from '@kangentic/protocol';
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
 * The host of an https URL, by string, for the reason `httpsUrlOrNull` gives
 * (Hermes' partial URL implementation). Drops any `user@`, port and `www.`.
 */
function hostOf(httpsUrl: string): string {
  const afterScheme = httpsUrl.slice('https://'.length);
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? '';
  const withoutUser = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const withoutPort = withoutUser.replace(/:\d+$/, '');
  return withoutPort.replace(/^www\./i, '').toLowerCase();
}

/**
 * A task's links that the phone may open (protocol 0.28.0), in the desktop's
 * order. Only https ones: the link is untrusted task text, and only an https
 * link is handed to the OS opener, as Chat's links are (`httpsUrlOrNull`). A
 * link that is not https is left out rather than drawn as a row that refuses.
 * Null or absent on the row (an older desktop) reads as none.
 */
export function openableArtifacts(artifacts: readonly BoardTaskArtifactWire[] | null | undefined): TaskArtifactLink[] {
  if (!artifacts) return [];
  return artifacts.flatMap((artifact): TaskArtifactLink[] => {
    const url = httpsUrlOrNull(artifact.url);
    if (url === null) return [];
    const host = hostOf(url);
    const trimmedName = artifact.name.trim();
    const name = (trimmedName.length > 0 ? trimmedName : host).slice(0, ARTIFACT_NAME_MAX_LENGTH);
    return [{ url, name, host }];
  });
}

/** The several-links row's caption: every name, comma separated, for its one truncating line. */
export function artifactNamesCaption(links: readonly TaskArtifactLink[]): string {
  return links.map((link) => link.name).join(', ');
}

/** The completed strip's chip for several links: the desktop chip's "N artifacts". */
export function artifactCountLabel(count: number): string {
  return count === 1 ? '1 artifact' : `${count} artifacts`;
}
