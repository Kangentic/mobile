/**
 * Drives both stages of scripts/prepareAppStoreRelease.mjs against an in-memory
 * App Store Connect, so the "100% every time" guarantees are checked without a
 * key or a network call.
 *
 * The fake is stateful on purpose. Each stage ends by reading the version back
 * and failing if the settings did not stick, so a fake that only recorded calls
 * would let a skipped write pass. Here a skipped PATCH or DELETE leaves the old
 * value in place and the read-back catches it, which is the same thing that
 * would happen against Apple.
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  appendStepSummary,
  checkAppStoreRelease,
  createRequest,
  formatReport,
  main,
  parseArguments,
  prepareAppStoreRelease,
  readWhatsNewFrom,
  submitAppStoreRelease,
} from '../../scripts/prepareAppStoreRelease.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const APP_ID = 'app-1';
const BUNDLE_ID = 'com.example.app';
const VERSION_STRING = '1.2.0';
const BUILD_NUMBER = '20';
const BUILD_ID = 'build-20';

interface FakeVersion {
  id: string;
  versionString: string;
  appVersionState: string;
  releaseType: string;
  buildId: string | null;
  phasedRelease: { id: string; phasedReleaseState: string } | null;
  reviewDetail: Record<string, string | boolean> | null;
  createdDate?: string;
}

interface FakeLocalization {
  id: string;
  versionId: string;
  locale: string;
  whatsNew: string;
  screenshotCount: number;
}

interface FakeReviewSubmission {
  id: string;
  state: string;
  versionIds: string[];
}

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

interface FakeSeed {
  buildState?: string;
  versions?: FakeVersion[];
  localizations?: FakeLocalization[];
  reviewSubmissions?: FakeReviewSubmission[];
  /** What Apple copies onto a version created through the API. */
  newVersionLocalizations?: { locale: string; screenshotCount: number }[];
  newVersionReviewDetail?: Record<string, string | boolean> | null;
  /** `METHOD path` prefixes answered with a 403. */
  forbidden?: string[];
  /** `METHOD path` prefixes answered with the given status (a 401 or a 500, say). */
  failWith?: { prefix: string; status: number }[];
  /**
   * Exact `METHOD pathname` values (query string excluded) whose write is
   * accepted with a success status but silently NOT applied, which is what a
   * setting Apple refuses to keep looks like from the outside. Exact, not a
   * prefix: `PATCH /appStoreVersions/version-1` would otherwise also swallow the
   * build attachment under it.
   */
  ignoreWrites?: string[];
  /**
   * How the screenshot sets report their screenshots: only through each set's
   * relationship linkage, only through `included`, or (the default) both.
   */
  screenshotShape?: 'linkage-only' | 'included-only';
  /** States a submitted review submission reads on successive reads. */
  submittedStates?: string[];
}

const COMPLETE_REVIEW_DETAIL: Record<string, string> = {
  contactFirstName: 'Pat',
  contactLastName: 'Reviewer',
  contactPhone: '+1 555 0100',
  contactEmail: 'review@example.com',
  notes: 'Pair with demo code DEMO-CODE-123.',
  demoAccountPassword: 'not-a-real-secret',
};

const RELEASE_NOTES = 'Command Terminals, and a faster board.\n';

function readWhatsNewFor(available: Record<string, string>) {
  return (locale: string): string | undefined => available[locale];
}

function editableVersion(overrides: Partial<FakeVersion> = {}): FakeVersion {
  return {
    id: 'version-1',
    versionString: VERSION_STRING,
    appVersionState: 'PREPARE_FOR_SUBMISSION',
    releaseType: 'MANUAL',
    buildId: null,
    phasedRelease: null,
    reviewDetail: { ...COMPLETE_REVIEW_DETAIL },
    ...overrides,
  };
}

function englishLocalization(overrides: Partial<FakeLocalization> = {}): FakeLocalization {
  return {
    id: 'localization-en',
    versionId: 'version-1',
    locale: 'en-US',
    whatsNew: '',
    screenshotCount: 7,
    ...overrides,
  };
}

function createFakeAppStoreConnect(seed: FakeSeed = {}) {
  const versions: FakeVersion[] = (seed.versions ?? []).map((version) => ({ ...version }));
  const localizations: FakeLocalization[] = (seed.localizations ?? []).map((localization) => ({
    ...localization,
  }));
  const reviewSubmissions: FakeReviewSubmission[] = (seed.reviewSubmissions ?? []).map((submission) => ({
    ...submission,
    versionIds: [...submission.versionIds],
  }));
  const submittedStates = [...(seed.submittedStates ?? ['WAITING_FOR_REVIEW'])];
  const calls: RecordedCall[] = [];

  const respond = (status: number, body: unknown = {}) => ({ ok: status < 300, status, body });
  const notFound = (method: string, apiPath: string) =>
    respond(404, { errors: [{ title: 'Not routed by the fake', detail: `${method} ${apiPath}` }] });

  function versionResource(version: FakeVersion) {
    return {
      type: 'appStoreVersions',
      id: version.id,
      attributes: {
        versionString: version.versionString,
        appVersionState: version.appVersionState,
        releaseType: version.releaseType,
        createdDate: version.createdDate ?? '2026-10-01T00:00:00-07:00',
      },
      relationships: {
        build: { data: version.buildId ? { type: 'builds', id: version.buildId } : null },
        appStoreVersionPhasedRelease: {
          data: version.phasedRelease
            ? { type: 'appStoreVersionPhasedReleases', id: version.phasedRelease.id }
            : null,
        },
        appStoreReviewDetail: {
          data: version.reviewDetail ? { type: 'appStoreReviewDetails', id: `review-${version.id}` } : null,
        },
      },
    };
  }

  function includedFor(version: FakeVersion) {
    const included: unknown[] = [];
    if (version.phasedRelease) {
      included.push({
        type: 'appStoreVersionPhasedReleases',
        id: version.phasedRelease.id,
        attributes: { phasedReleaseState: version.phasedRelease.phasedReleaseState },
      });
    }
    if (version.reviewDetail) {
      included.push({ type: 'appStoreReviewDetails', id: `review-${version.id}`, attributes: version.reviewDetail });
    }
    return included;
  }

  async function request(method: string, apiPath: string, body?: unknown) {
    calls.push({ method, path: apiPath, body });
    if ((seed.forbidden ?? []).some((prefix) => `${method} ${apiPath}`.startsWith(prefix))) {
      return respond(403, { errors: [{ title: 'Forbidden', detail: 'A required role is missing.' }] });
    }

    const failure = (seed.failWith ?? []).find((candidate) =>
      `${method} ${apiPath}`.startsWith(candidate.prefix)
    );
    if (failure) {
      return respond(failure.status, { errors: [{ title: 'Injected failure', detail: `status ${failure.status}` }] });
    }

    const [pathname, query = ''] = apiPath.split('?');
    const params = new URLSearchParams(query);
    const requestData = (body as { data?: { attributes?: Record<string, unknown> } } | undefined)?.data;
    let match: RegExpMatchArray | null;

    if (method !== 'GET' && (seed.ignoreWrites ?? []).includes(`${method} ${pathname}`)) {
      return respond(method === 'DELETE' ? 204 : 200, {});
    }

    if (method === 'GET' && pathname === '/apps') {
      return respond(200, { data: params.get('filter[bundleId]') === BUNDLE_ID ? [{ type: 'apps', id: APP_ID }] : [] });
    }
    if (method === 'GET' && pathname === '/builds') {
      // The check mode asks without a build number, so an absent filter matches too.
      const buildNumberFilter = params.get('filter[version]');
      const matches =
        (buildNumberFilter === null || buildNumberFilter === BUILD_NUMBER) &&
        params.get('filter[preReleaseVersion.version]') === VERSION_STRING;
      return respond(200, {
        data: matches
          ? [{ type: 'builds', id: BUILD_ID, attributes: { version: BUILD_NUMBER, processingState: seed.buildState ?? 'VALID' } }]
          : [],
      });
    }
    if (method === 'GET' && pathname === `/apps/${APP_ID}/appStoreVersions`) {
      const versionString = params.get('filter[versionString]');
      const states = params.get('filter[appVersionState]')?.split(',');
      const selected = versions.filter(
        (version) =>
          (versionString === null || version.versionString === versionString) &&
          (states === undefined || states.includes(version.appVersionState))
      );
      return respond(200, {
        data: selected.map(versionResource),
        included: selected.flatMap(includedFor),
      });
    }
    if (method === 'POST' && pathname === '/appStoreVersions') {
      const attributes = requestData?.attributes ?? {};
      const created: FakeVersion = {
        id: 'version-new',
        versionString: String(attributes.versionString),
        appVersionState: 'PREPARE_FOR_SUBMISSION',
        releaseType: String(attributes.releaseType ?? 'MANUAL'),
        buildId: null,
        phasedRelease: null,
        reviewDetail: seed.newVersionReviewDetail === undefined ? { ...COMPLETE_REVIEW_DETAIL } : seed.newVersionReviewDetail,
      };
      versions.push(created);
      for (const [index, copied] of (seed.newVersionLocalizations ?? [{ locale: 'en-US', screenshotCount: 7 }]).entries()) {
        localizations.push({
          id: `localization-new-${index}`,
          versionId: created.id,
          locale: copied.locale,
          whatsNew: '',
          screenshotCount: copied.screenshotCount,
        });
      }
      return respond(201, { data: versionResource(created) });
    }
    if ((match = pathname.match(/^\/appStoreVersions\/([^/]+)\/relationships\/build$/)) && method === 'PATCH') {
      const version = versions.find((candidate) => candidate.id === match?.[1]);
      if (!version) return notFound(method, apiPath);
      version.buildId = (body as { data: { id: string } }).data.id;
      return respond(200, body);
    }
    if ((match = pathname.match(/^\/appStoreVersions\/([^/]+)$/)) && method === 'PATCH') {
      const version = versions.find((candidate) => candidate.id === match?.[1]);
      if (!version) return notFound(method, apiPath);
      if (requestData?.attributes?.releaseType) version.releaseType = String(requestData.attributes.releaseType);
      return respond(200, { data: versionResource(version) });
    }
    if ((match = pathname.match(/^\/appStoreVersionPhasedReleases\/([^/]+)$/)) && method === 'DELETE') {
      const version = versions.find((candidate) => candidate.phasedRelease?.id === match?.[1]);
      if (!version) return notFound(method, apiPath);
      version.phasedRelease = null;
      return respond(204);
    }
    if (method === 'POST' && pathname === '/appStoreReviewDetails') {
      const versionId = (body as { data: { relationships: { appStoreVersion: { data: { id: string } } } } }).data
        .relationships.appStoreVersion.data.id;
      const version = versions.find((candidate) => candidate.id === versionId);
      if (!version) return notFound(method, apiPath);
      // Apple allows one review detail per version, so a second create conflicts.
      if (version.reviewDetail) {
        return respond(409, { errors: [{ title: 'Conflict', detail: 'The version already has a review detail.' }] });
      }
      version.reviewDetail = { ...(requestData?.attributes as Record<string, string | boolean>) };
      return respond(201, { data: { type: 'appStoreReviewDetails', id: `review-${version.id}` } });
    }
    if ((match = pathname.match(/^\/appStoreReviewDetails\/([^/]+)$/)) && method === 'PATCH') {
      const version = versions.find((candidate) => `review-${candidate.id}` === match?.[1]);
      if (!version?.reviewDetail) return notFound(method, apiPath);
      version.reviewDetail = { ...version.reviewDetail, ...(requestData?.attributes as Record<string, string | boolean>) };
      return respond(200, body);
    }
    if ((match = pathname.match(/^\/appStoreVersions\/([^/]+)\/appStoreVersionLocalizations$/)) && method === 'GET') {
      return respond(200, {
        data: localizations
          .filter((localization) => localization.versionId === match?.[1])
          .map((localization) => ({
            type: 'appStoreVersionLocalizations',
            id: localization.id,
            attributes: { locale: localization.locale, whatsNew: localization.whatsNew },
          })),
      });
    }
    if ((match = pathname.match(/^\/appStoreVersionLocalizations\/([^/]+)$/)) && method === 'PATCH') {
      const localization = localizations.find((candidate) => candidate.id === match?.[1]);
      if (!localization) return notFound(method, apiPath);
      localization.whatsNew = String(requestData?.attributes?.whatsNew ?? '');
      return respond(200, body);
    }
    if ((match = pathname.match(/^\/appStoreVersionLocalizations\/([^/]+)\/appScreenshotSets$/)) && method === 'GET') {
      const localization = localizations.find((candidate) => candidate.id === match?.[1]);
      const screenshotIds = Array.from({ length: localization?.screenshotCount ?? 0 }, (_unused, index) => ({
        type: 'appScreenshots',
        id: `screenshot-${index}`,
      }));
      return respond(200, {
        data: [
          {
            type: 'appScreenshotSets',
            id: 'set-1',
            relationships:
              seed.screenshotShape === 'included-only' ? {} : { appScreenshots: { data: screenshotIds } },
          },
        ],
        included: seed.screenshotShape === 'linkage-only' ? [] : screenshotIds,
      });
    }
    if (method === 'GET' && pathname === `/apps/${APP_ID}/reviewSubmissions`) {
      const states = params.get('filter[state]')?.split(',') ?? [];
      return respond(200, {
        data: reviewSubmissions
          .filter((submission) => states.includes(submission.state))
          .map((submission) => ({ type: 'reviewSubmissions', id: submission.id, attributes: { state: submission.state } })),
      });
    }
    if (method === 'POST' && pathname === '/reviewSubmissions') {
      const created: FakeReviewSubmission = { id: 'submission-new', state: 'READY_FOR_REVIEW', versionIds: [] };
      reviewSubmissions.push(created);
      return respond(201, { data: { type: 'reviewSubmissions', id: created.id, attributes: { state: created.state } } });
    }
    if ((match = pathname.match(/^\/reviewSubmissions\/([^/]+)\/items$/)) && method === 'GET') {
      const submission = reviewSubmissions.find((candidate) => candidate.id === match?.[1]);
      return respond(200, {
        data: (submission?.versionIds ?? []).map((versionId, index) => ({
          type: 'reviewSubmissionItems',
          id: `item-${index}`,
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
        })),
      });
    }
    if (method === 'POST' && pathname === '/reviewSubmissionItems') {
      const relationships = (body as {
        data: { relationships: { reviewSubmission: { data: { id: string } }; appStoreVersion: { data: { id: string } } } };
      }).data.relationships;
      const submission = reviewSubmissions.find((candidate) => candidate.id === relationships.reviewSubmission.data.id);
      if (!submission) return notFound(method, apiPath);
      submission.versionIds.push(relationships.appStoreVersion.data.id);
      return respond(201, { data: { type: 'reviewSubmissionItems', id: 'item-new' } });
    }
    if ((match = pathname.match(/^\/reviewSubmissions\/([^/]+)$/)) && (method === 'PATCH' || method === 'GET')) {
      const submission = reviewSubmissions.find((candidate) => candidate.id === match?.[1]);
      if (!submission) return notFound(method, apiPath);
      if (method === 'PATCH' && requestData?.attributes?.submitted === true) {
        submission.state = submittedStates.shift() ?? submission.state;
        for (const version of versions.filter((candidate) => submission.versionIds.includes(candidate.id))) {
          version.appVersionState = 'WAITING_FOR_REVIEW';
        }
      } else if (method === 'GET' && submittedStates.length > 0) {
        submission.state = submittedStates.shift() ?? submission.state;
      }
      return respond(200, { data: { type: 'reviewSubmissions', id: submission.id, attributes: { state: submission.state } } });
    }
    return notFound(method, apiPath);
  }

  return { request, calls, versions, localizations, reviewSubmissions };
}

function writes(calls: RecordedCall[]) {
  return calls.filter((call) => call.method !== 'GET');
}

const releaseIdentity = { bundleId: BUNDLE_ID, versionString: VERSION_STRING, buildNumber: BUILD_NUMBER };

type FakeAppStoreConnect = ReturnType<typeof createFakeAppStoreConnect>;

/** A version stage 1 has already prepared: full-release settings in place, build attached. */
const preparedVersion = () => editableVersion({ releaseType: 'AFTER_APPROVAL', buildId: BUILD_ID });
const preparedLocalization = () => englishLocalization({ whatsNew: RELEASE_NOTES.trimEnd() });
const noWait = async () => undefined;

/** The message a promise rejects with, failing loudly (and clearly) when it resolves instead. */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the promise to reject, but it resolved.');
}

/** Runs one of the two writing stages against a fake, so a case can be stated once for both. */
function runWritingStage(
  stage: 'prepare' | 'submit',
  fake: FakeAppStoreConnect,
  identity: { bundleId: string; versionString: string; buildNumber: string } = releaseIdentity
) {
  return stage === 'prepare'
    ? prepareAppStoreRelease({
        request: fake.request,
        ...identity,
        readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
      })
    : submitAppStoreRelease({ request: fake.request, ...identity, sleep: noWait });
}

const WRITING_STAGES = ['prepare', 'submit'] as const;

describe('prepareAppStoreRelease', () => {
  it('creates the version set to release automatically after approval', async () => {
    const fake = createFakeAppStoreConnect();
    const report = await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
    });

    // Asserted on the create call itself, not only the end state: the later
    // PATCH would otherwise mask a create that asked for MANUAL.
    const create = fake.calls.find((call) => call.method === 'POST' && call.path === '/appStoreVersions');
    expect(create?.body).toMatchObject({
      data: { attributes: { platform: 'IOS', versionString: VERSION_STRING, releaseType: 'AFTER_APPROVAL' } },
    });
    expect(fake.versions[0]).toMatchObject({ releaseType: 'AFTER_APPROVAL', buildId: BUILD_ID, phasedRelease: null });
    expect(report.alreadyDone).toBe(false);
    expect(report.problems).toEqual([]);
  });

  it('fills What\'s New from the release notes file, trailing newline trimmed', async () => {
    const fake = createFakeAppStoreConnect();
    await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
    });
    expect(fake.localizations[0].whatsNew).toBe(RELEASE_NOTES.trimEnd());
  });

  it('switches an existing draft from a manual release to release after approval', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ releaseType: 'MANUAL' })],
      localizations: [englishLocalization()],
    });
    const report = await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
    });
    expect(fake.versions[0].releaseType).toBe('AFTER_APPROVAL');
    expect(report.changes).toContain('releaseType MANUAL -> AFTER_APPROVAL');
  });

  it('cancels a planned phased release, so the update reaches every user at once', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ phasedRelease: { id: 'phased-1', phasedReleaseState: 'INACTIVE' } })],
      localizations: [englishLocalization()],
    });
    await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
    });
    expect(fake.calls).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/appStoreVersionPhasedReleases/phased-1' })
    );
    expect(fake.versions[0].phasedRelease).toBeNull();
  });

  it('refuses a phased release that has already started rather than guessing', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ phasedRelease: { id: 'phased-1', phasedReleaseState: 'ACTIVE' } })],
      localizations: [englishLocalization()],
    });
    await expect(
      prepareAppStoreRelease({ request: fake.request, ...releaseIdentity, readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }) })
    ).rejects.toThrow(/ACTIVE, which cannot be cancelled/);
  });

  it('refuses to reuse a version string that is already live', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ appVersionState: 'READY_FOR_DISTRIBUTION', buildId: 'build-19' })],
    });
    await expect(
      prepareAppStoreRelease({ request: fake.request, ...releaseIdentity, readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }) })
    ).rejects.toThrow(/bump `version`/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('is a no-op when this exact build is already waiting for review', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ appVersionState: 'WAITING_FOR_REVIEW', buildId: BUILD_ID, releaseType: 'AFTER_APPROVAL' })],
    });
    const report = await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
    });
    expect(report.alreadyDone).toBe(true);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('names a draft under another version string instead of failing on an opaque conflict', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ id: 'version-old', versionString: '1.1.9' })],
    });
    await expect(
      prepareAppStoreRelease({ request: fake.request, ...releaseIdentity, readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }) })
    ).rejects.toThrow(/unreleased iOS version 1\.1\.9/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('refuses a build Apple has not finished processing', async () => {
    const fake = createFakeAppStoreConnect({ buildState: 'PROCESSING' });
    await expect(
      prepareAppStoreRelease({ request: fake.request, ...releaseIdentity, readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }) })
    ).rejects.toThrow(/PROCESSING, not VALID/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('fails before writing any What\'s New when a localization has no release notes file', async () => {
    const fake = createFakeAppStoreConnect({
      newVersionLocalizations: [
        { locale: 'en-US', screenshotCount: 7 },
        { locale: 'de-DE', screenshotCount: 7 },
      ],
    });
    await expect(
      prepareAppStoreRelease({ request: fake.request, ...releaseIdentity, readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }) })
    ).rejects.toThrow(/No release notes for de-DE/);
    expect(fake.calls.filter((call) => call.path.startsWith('/appStoreVersionLocalizations/') && call.method === 'PATCH')).toEqual([]);
  });

  it('names the App Manager role when Apple answers 403', async () => {
    const fake = createFakeAppStoreConnect({ forbidden: ['POST /appStoreVersions'] });
    await expect(
      prepareAppStoreRelease({ request: fake.request, ...releaseIdentity, readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }) })
    ).rejects.toThrow(/App Manager/);
  });

  it('reports missing review notes and screenshots without failing, and never logs their values', async () => {
    // Stage 1 must succeed here: the gap before the second approval is where a
    // human fixes exactly these. It reports presence only, because the notes
    // carry the reviewer demo pairing code.
    const fake = createFakeAppStoreConnect({
      newVersionLocalizations: [{ locale: 'en-US', screenshotCount: 0 }],
      newVersionReviewDetail: { ...COMPLETE_REVIEW_DETAIL, notes: '' },
    });
    const logged: string[] = [];
    const report = await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
      log: (line: string) => logged.push(line),
    });
    expect(report.reviewDetail).toEqual({ hasContact: true, hasNotes: false });
    expect(report.localizations).toEqual([{ locale: 'en-US', hasWhatsNew: true, screenshotCount: 0 }]);
    expect(report.problems.join('\n')).toMatch(/review notes are empty/i);
    expect(report.problems.join('\n')).toMatch(/en-US has no screenshots/);
    const output = logged.join('\n');
    expect(output).toMatch(/0 screenshot\(s\)/);
    for (const secret of [COMPLETE_REVIEW_DETAIL.contactEmail, COMPLETE_REVIEW_DETAIL.demoAccountPassword]) {
      expect(output).not.toContain(secret);
    }
  });
});

describe('submitAppStoreRelease', () => {
  it('submits the prepared version for review', async () => {
    const fake = createFakeAppStoreConnect({ versions: [preparedVersion()], localizations: [preparedLocalization()] });
    const report = await submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait });

    const writeSequence = writes(fake.calls).map((call) => `${call.method} ${call.path}`);
    expect(writeSequence).toEqual([
      'POST /reviewSubmissions',
      'POST /reviewSubmissionItems',
      'PATCH /reviewSubmissions/submission-new',
    ]);
    expect(writes(fake.calls)[2].body).toMatchObject({ data: { attributes: { submitted: true } } });
    expect(report.state).toBe('WAITING_FOR_REVIEW');
  });

  it('reuses an open review submission rather than opening a second one', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [preparedLocalization()],
      reviewSubmissions: [{ id: 'submission-open', state: 'READY_FOR_REVIEW', versionIds: [] }],
    });
    await submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait });
    expect(fake.calls.some((call) => call.method === 'POST' && call.path === '/reviewSubmissions')).toBe(false);
    expect(fake.reviewSubmissions[0].versionIds).toEqual(['version-1']);
  });

  it('cancels a phased release someone switched on between the two approvals', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [{ ...preparedVersion(), phasedRelease: { id: 'phased-2', phasedReleaseState: 'INACTIVE' } }],
      localizations: [preparedLocalization()],
    });
    const logged: string[] = [];
    await submitAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      sleep: noWait,
      log: (line: string) => logged.push(line),
    });
    const writeSequence = writes(fake.calls).map((call) => `${call.method} ${call.path}`);
    // Cancelled before the version is handed to App Review, not after.
    expect(writeSequence.indexOf('DELETE /appStoreVersionPhasedReleases/phased-2')).toBeGreaterThan(-1);
    expect(writeSequence.indexOf('DELETE /appStoreVersionPhasedReleases/phased-2')).toBeLessThan(
      writeSequence.indexOf('PATCH /reviewSubmissions/submission-new')
    );
    expect(logged.join('\n')).toMatch(/Re-applied between the stages: cancelled the planned 7-day phased release/);
  });

  it('is a no-op on a re-run once the version is waiting for review', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [{ ...preparedVersion(), appVersionState: 'WAITING_FOR_REVIEW' }],
      localizations: [preparedLocalization()],
    });
    const report = await submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait });
    expect(report.alreadyDone).toBe(true);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('refuses to submit when the review notes are empty', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [{ ...preparedVersion(), reviewDetail: { ...COMPLETE_REVIEW_DETAIL, notes: '   ' } }],
      localizations: [preparedLocalization()],
    });
    await expect(
      submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait })
    ).rejects.toThrow(/review notes are empty/i);
    expect(fake.calls.some((call) => call.path.startsWith('/reviewSubmission'))).toBe(false);
  });

  it('refuses to submit when a localization has no screenshots', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [{ ...preparedLocalization(), screenshotCount: 0 }],
    });
    await expect(
      submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait })
    ).rejects.toThrow(/en-US has no screenshots/);
    expect(fake.calls.some((call) => call.path.startsWith('/reviewSubmission'))).toBe(false);
  });

  it('waits for the submission to read WAITING_FOR_REVIEW, and fails if it never does', async () => {
    const settles = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [preparedLocalization()],
      submittedStates: ['READY_FOR_REVIEW', 'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW'],
    });
    const settled = await submitAppStoreRelease({ request: settles.request, ...releaseIdentity, sleep: noWait });
    expect(settled.state).toBe('WAITING_FOR_REVIEW');

    const stuck = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [preparedLocalization()],
      submittedStates: ['READY_FOR_REVIEW'],
    });
    await expect(
      submitAppStoreRelease({ request: stuck.request, ...releaseIdentity, sleep: noWait, pollAttempts: 3 })
    ).rejects.toThrow(/still reads READY_FOR_REVIEW/);
  });
});

describe('stage 1 and the one-unreleased-version rule', () => {
  // Apple allows one unreleased version per platform. A version in review, or
  // approved and waiting to release, holds that slot as surely as a draft does.
  // A LIVE version holds nothing: refusing on it would block every release that
  // follows it, which is the release-day case.
  const releasedVersions = () => [
    editableVersion({
      id: 'version-live',
      versionString: '1.1.0',
      appVersionState: 'READY_FOR_DISTRIBUTION',
      releaseType: 'AFTER_APPROVAL',
      buildId: 'build-18',
    }),
    editableVersion({
      id: 'version-replaced',
      versionString: '1.0.0',
      appVersionState: 'REPLACED_WITH_NEW_VERSION',
      buildId: 'build-15',
    }),
  ];

  it('creates the next version beside a live one, and asks only about unreleased states', async () => {
    const fake = createFakeAppStoreConnect({ versions: releasedVersions() });
    const report = await runWritingStage('prepare', fake);

    expect(fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/appStoreVersions' }));
    expect(report.alreadyDone).toBe(false);
    expect(report.state).toBe('PREPARE_FOR_SUBMISSION');

    const unreleasedQuery = fake.calls.find(
      (call) => call.method === 'GET' && call.path.includes('filter[appVersionState]=')
    );
    expect(unreleasedQuery).toBeDefined();
    const queriedStates =
      new URLSearchParams((unreleasedQuery?.path ?? '').split('?')[1]).get('filter[appVersionState]')?.split(',') ?? [];
    expect(queriedStates).toEqual(
      expect.arrayContaining([
        'PREPARE_FOR_SUBMISSION',
        'WAITING_FOR_REVIEW',
        'IN_REVIEW',
        'PENDING_APPLE_RELEASE',
        'PENDING_DEVELOPER_RELEASE',
      ])
    );
    for (const releasedState of ['READY_FOR_DISTRIBUTION', 'REPLACED_WITH_NEW_VERSION', 'READY_FOR_SALE']) {
      expect(queriedStates).not.toContain(releasedState);
    }
  });

  it.each(['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE'])(
    'refuses to create a version next to one that is %s, and says to wait rather than to delete',
    async (otherState) => {
      const fake = createFakeAppStoreConnect({
        versions: [
          editableVersion({ id: 'version-other', versionString: '1.1.9', appVersionState: otherState, buildId: 'build-19' }),
        ],
      });
      const message = await rejectionMessage(runWritingStage('prepare', fake));
      expect(message).toContain(`already has iOS version 1.1.9 in ${otherState}`);
      expect(message).toMatch(/Wait for it, or withdraw it from review/);
      expect(message).not.toMatch(/Delete that draft/);
      expect(writes(fake.calls)).toEqual([]);
    }
  );
});

describe('stage 1 carries the App Review Information over to a new version', () => {
  // Apple does not document whether a version created through the API inherits
  // the previous version's App Review Information, and stage 2 refuses without
  // it. Stage 1 copies what the new version lacks from the newest complete one.
  const liveVersion = (overrides: Partial<FakeVersion> = {}) =>
    editableVersion({
      id: 'version-live',
      versionString: '1.1.0',
      appVersionState: 'READY_FOR_DISTRIBUTION',
      releaseType: 'AFTER_APPROVAL',
      buildId: 'build-18',
      createdDate: '2026-10-12T00:00:00-07:00',
      ...overrides,
    });
  const replacedVersion = (id: string, versionString: string, createdDate: string, notes: string) =>
    editableVersion({
      id,
      versionString,
      appVersionState: 'REPLACED_WITH_NEW_VERSION',
      buildId: `build-${id}`,
      createdDate,
      reviewDetail: { ...COMPLETE_REVIEW_DETAIL, notes },
    });
  const reviewDetailWrites = (fake: FakeAppStoreConnect) =>
    fake.calls.filter((call) => call.method !== 'GET' && call.path.startsWith('/appStoreReviewDetails'));
  const createdVersion = (fake: FakeAppStoreConnect) => fake.versions.find((version) => version.id === 'version-new');

  it('creates the details on a new version that has none, from the live version, and never logs them', async () => {
    const fake = createFakeAppStoreConnect({ versions: [liveVersion()], newVersionReviewDetail: null });
    const logged: string[] = [];
    const report = await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
      log: (line: string) => logged.push(line),
    });

    const [create, ...others] = reviewDetailWrites(fake);
    expect(others).toEqual([]);
    expect(create).toMatchObject({
      method: 'POST',
      path: '/appStoreReviewDetails',
      body: { data: { relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'version-new' } } } } },
    });
    expect(createdVersion(fake)?.reviewDetail).toEqual(COMPLETE_REVIEW_DETAIL);
    expect(report.reviewDetail).toEqual({ hasContact: true, hasNotes: true });
    expect(report.problems).toEqual([]);
    expect(report.changes.join('\n')).toMatch(/App Review Information carried over from version 1\.1\.0/);
    const output = logged.join('\n');
    for (const secret of [
      COMPLETE_REVIEW_DETAIL.notes,
      COMPLETE_REVIEW_DETAIL.contactEmail,
      COMPLETE_REVIEW_DETAIL.contactPhone,
      COMPLETE_REVIEW_DETAIL.demoAccountPassword,
    ]) {
      expect(output).not.toContain(secret);
    }
  });

  it('fills only the fields an existing detail lacks, leaving the ones it has alone', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [liveVersion()],
      newVersionReviewDetail: { ...COMPLETE_REVIEW_DETAIL, contactPhone: '+1 555 0199', notes: '' },
    });
    const report = await runWritingStage('prepare', fake);

    expect(reviewDetailWrites(fake)).toEqual([
      {
        method: 'PATCH',
        path: '/appStoreReviewDetails/review-version-new',
        body: {
          data: {
            type: 'appStoreReviewDetails',
            id: 'review-version-new',
            attributes: { notes: COMPLETE_REVIEW_DETAIL.notes },
          },
        },
      },
    ]);
    expect(createdVersion(fake)?.reviewDetail).toMatchObject({
      contactPhone: '+1 555 0199',
      notes: COMPLETE_REVIEW_DETAIL.notes,
    });
    expect(report.problems).toEqual([]);
  });

  it('writes no details to a new version whose own are already complete', async () => {
    const fake = createFakeAppStoreConnect({ versions: [liveVersion()] });
    await runWritingStage('prepare', fake);
    expect(reviewDetailWrites(fake)).toEqual([]);
  });

  it('copies from the newest version whose details are complete, passing over a newer incomplete one', async () => {
    // Listed oldest first, so taking the first complete version would pick 0.9.0.
    const fake = createFakeAppStoreConnect({
      versions: [
        replacedVersion('version-oldest', '0.9.0', '2026-09-01T00:00:00-07:00', 'Oldest notes.'),
        replacedVersion('version-older', '1.0.0', '2026-10-07T00:00:00-07:00', 'Pair with demo code DEMO-CODE-100.'),
        liveVersion({ reviewDetail: { ...COMPLETE_REVIEW_DETAIL, notes: '' } }),
      ],
      newVersionReviewDetail: null,
    });
    const report = await runWritingStage('prepare', fake);

    expect(createdVersion(fake)?.reviewDetail?.notes).toBe('Pair with demo code DEMO-CODE-100.');
    expect(report.changes.join('\n')).toMatch(/carried over from version 1\.0\.0/);
  });

  it('leaves the details missing, and reported, when no other version has complete ones', async () => {
    const fake = createFakeAppStoreConnect({ versions: [liveVersion({ reviewDetail: null })], newVersionReviewDetail: null });
    const report = await runWritingStage('prepare', fake);

    expect(reviewDetailWrites(fake)).toEqual([]);
    expect(report.problems.join('\n')).toMatch(/no App Review Information/);
  });
});

describe.each(WRITING_STAGES)('%s: an existing version, and the lookups it depends on', (stage) => {
  const droppedWrites = [
    {
      name: 'the release type',
      createVersion: () => editableVersion({ releaseType: 'MANUAL', buildId: BUILD_ID }),
      ignoredWrite: 'PATCH /appStoreVersions/version-1',
      problem: 'releaseType is MANUAL',
    },
    {
      name: 'the build attachment',
      createVersion: () => editableVersion({ releaseType: 'AFTER_APPROVAL', buildId: null }),
      ignoredWrite: 'PATCH /appStoreVersions/version-1/relationships/build',
      problem: 'the build is not attached',
    },
    {
      name: 'the phased release cancellation',
      createVersion: () =>
        editableVersion({
          releaseType: 'AFTER_APPROVAL',
          buildId: BUILD_ID,
          phasedRelease: { id: 'phased-1', phasedReleaseState: 'INACTIVE' },
        }),
      ignoredWrite: 'DELETE /appStoreVersionPhasedReleases/phased-1',
      problem: 'a phased release is still attached',
    },
  ];

  it.each(droppedWrites)(
    'rejects when App Store Connect accepts but does not keep $name',
    async ({ createVersion, ignoredWrite, problem }) => {
      // The read-back is the only thing that can notice a write Apple answered
      // 200 to and then did not apply.
      const fake = createFakeAppStoreConnect({
        versions: [createVersion()],
        localizations: [preparedLocalization()],
        ignoreWrites: [ignoredWrite],
      });
      const message = await rejectionMessage(runWritingStage(stage, fake));
      expect(message).toMatch(/did not keep the full-release settings/);
      expect(message).toContain(problem);

      // The write WAS attempted, so the rejection comes from the read-back and
      // not from a write the stage never made.
      const [ignoredMethod, ignoredPath] = ignoredWrite.split(' ');
      expect(fake.calls).toContainEqual(expect.objectContaining({ method: ignoredMethod, path: ignoredPath }));
      // A version that failed the read-back is never handed to App Review.
      expect(fake.calls.some((call) => call.path.startsWith('/reviewSubmission'))).toBe(false);
    }
  );

  it.each(['WAITING_FOR_REVIEW', 'IN_REVIEW'])(
    'refuses a version already %s with a different build, writing nothing',
    async (inReviewState) => {
      const fake = createFakeAppStoreConnect({
        versions: [editableVersion({ appVersionState: inReviewState, releaseType: 'AFTER_APPROVAL', buildId: 'build-19' })],
        localizations: [preparedLocalization()],
      });
      const message = await rejectionMessage(runWritingStage(stage, fake));
      expect(message).toContain(`already ${inReviewState} with a different build`);
      expect(writes(fake.calls)).toEqual([]);
    }
  );

  it('is a no-op for a version past review that already carries this build', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [
        editableVersion({ appVersionState: 'READY_FOR_DISTRIBUTION', releaseType: 'AFTER_APPROVAL', buildId: BUILD_ID }),
      ],
    });
    const report = await runWritingStage(stage, fake);
    expect(report.alreadyDone).toBe(true);
    expect(report.state).toBe('READY_FOR_DISTRIBUTION');
    expect(writes(fake.calls)).toEqual([]);
  });

  it('asks for a new version string when a past-review version carries a different build', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ appVersionState: 'READY_FOR_DISTRIBUTION', buildId: 'build-19' })],
    });
    await expect(runWritingStage(stage, fake)).rejects.toThrow(/already READY_FOR_DISTRIBUTION.*bump `version`/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('refuses a state it does not recognise rather than guessing', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [editableVersion({ appVersionState: 'REMOVED_FROM_SALE', buildId: BUILD_ID })],
    });
    await expect(runWritingStage(stage, fake)).rejects.toThrow(/REMOVED_FROM_SALE, which this script does not know how to move on from/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('names a bundle id that App Store Connect has no app for', async () => {
    const fake = createFakeAppStoreConnect();
    const message = await rejectionMessage(
      runWritingStage(stage, fake, { ...releaseIdentity, bundleId: 'com.example.other' })
    );
    expect(message).toContain('App Store Connect has no app with bundle id com.example.other.');
    expect(writes(fake.calls)).toEqual([]);
  });

  it('asks for the build by its number, so a crowded page of builds cannot push it out', async () => {
    // The page is limited to 10, and a version string can have more builds than
    // that. The caller's own .find() would hide a dropped filter, since the fake
    // answers either way, so assert on the request.
    const fake = createFakeAppStoreConnect({
      versions: [
        editableVersion({ appVersionState: 'READY_FOR_DISTRIBUTION', releaseType: 'AFTER_APPROVAL', buildId: BUILD_ID }),
      ],
    });
    await runWritingStage(stage, fake);
    const buildsRead = fake.calls.find((call) => call.path.startsWith('/builds?'));
    expect(buildsRead).toBeDefined();
    expect(buildsRead?.path).toContain(`filter[version]=${BUILD_NUMBER}`);
    expect(buildsRead?.path).toContain(`filter[preReleaseVersion.version]=${VERSION_STRING}`);
  });

  it('names a build number that Apple has no record of', async () => {
    const fake = createFakeAppStoreConnect();
    const message = await rejectionMessage(runWritingStage(stage, fake, { ...releaseIdentity, buildNumber: '21' }));
    expect(message).toContain('No build 21 for version 1.2.0 on App Store Connect.');
    expect(writes(fake.calls)).toEqual([]);
  });
});

describe('prepareAppStoreRelease: a re-run that finds everything in place', () => {
  it('writes nothing and reports no changes when What\'s New already matches', async () => {
    const fake = createFakeAppStoreConnect({ versions: [preparedVersion()], localizations: [preparedLocalization()] });
    const report = await runWritingStage('prepare', fake);
    expect(writes(fake.calls)).toEqual([]);
    expect(report.changes).toEqual([]);
    expect(report.alreadyDone).toBe(false);
  });

  it('reports a version with no localizations as NONE, and as something to fix before submitting', async () => {
    const fake = createFakeAppStoreConnect({ newVersionLocalizations: [] });
    const logged: string[] = [];
    const report = await prepareAppStoreRelease({
      request: fake.request,
      ...releaseIdentity,
      readWhatsNew: readWhatsNewFor({ 'en-US': RELEASE_NOTES }),
      log: (line: string) => logged.push(line),
    });
    expect(report.localizations).toEqual([]);
    expect(logged).toContain('- Localizations: NONE.');
    expect(formatReport(report)).toContain('- Localizations: NONE.');
    expect(report.problems).toContain('The version has no localizations.');
  });
});

describe('submitAppStoreRelease: refusals, open submissions and polling', () => {
  it('says the prepare stage creates a version that does not exist, writing nothing', async () => {
    const fake = createFakeAppStoreConnect();
    const message = await rejectionMessage(
      submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait })
    );
    expect(message).toMatch(/There is no App Store version 1\.2\.0\. The prepare stage creates it/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it.each([
    {
      name: 'incomplete contact details',
      version: () => ({ ...preparedVersion(), reviewDetail: { ...COMPLETE_REVIEW_DETAIL, contactPhone: '' } }),
      localizations: () => [preparedLocalization()],
      problem: /contact details are incomplete/,
    },
    {
      name: 'no localizations',
      version: () => preparedVersion(),
      localizations: () => [],
      problem: /The version has no localizations/,
    },
    {
      name: 'a localization with no What\'s New text',
      version: () => preparedVersion(),
      localizations: () => [{ ...preparedLocalization(), whatsNew: '' }],
      problem: /en-US has no What's New text/,
    },
    {
      name: 'no App Review Information',
      version: () => ({ ...preparedVersion(), reviewDetail: null }),
      localizations: () => [preparedLocalization()],
      problem: /no App Review Information/,
    },
  ])('refuses to submit a version with $name, and never opens a review submission', async (scenario) => {
    const fake = createFakeAppStoreConnect({
      versions: [scenario.version()],
      localizations: scenario.localizations(),
    });
    const message = await rejectionMessage(
      submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait })
    );
    expect(message).toMatch(/Not submitting version 1\.2\.0 for review/);
    expect(message).toMatch(scenario.problem);
    expect(fake.calls.some((call) => call.path.startsWith('/reviewSubmission'))).toBe(false);
  });

  it('adds nothing to an open submission that already holds the version, and still submits it', async () => {
    // UNRESOLVED_ISSUES is an open state too: Apple flags the submission and
    // leaves the item in it, so a second item for the same version would be
    // refused as a duplicate.
    const fake = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [preparedLocalization()],
      reviewSubmissions: [{ id: 'submission-open', state: 'UNRESOLVED_ISSUES', versionIds: ['version-1'] }],
    });
    const report = await submitAppStoreRelease({ request: fake.request, ...releaseIdentity, sleep: noWait });

    expect(writes(fake.calls).map((call) => `${call.method} ${call.path}`)).toEqual([
      'PATCH /reviewSubmissions/submission-open',
    ]);
    expect(writes(fake.calls)[0].body).toMatchObject({ data: { attributes: { submitted: true } } });
    expect(report.state).toBe('WAITING_FOR_REVIEW');
  });

  it('reads the version back only when a write needs proving: once if nothing changed, twice if something did', async () => {
    const versionReads = (fake: FakeAppStoreConnect) =>
      fake.calls.filter((call) => call.method === 'GET' && call.path.startsWith(`/apps/${APP_ID}/appStoreVersions`));

    const untouched = createFakeAppStoreConnect({ versions: [preparedVersion()], localizations: [preparedLocalization()] });
    await submitAppStoreRelease({ request: untouched.request, ...releaseIdentity, sleep: noWait });
    expect(versionReads(untouched)).toHaveLength(1);

    const phasedSwitchedOn = createFakeAppStoreConnect({
      versions: [{ ...preparedVersion(), phasedRelease: { id: 'phased-2', phasedReleaseState: 'INACTIVE' } }],
      localizations: [preparedLocalization()],
    });
    await submitAppStoreRelease({ request: phasedSwitchedOn.request, ...releaseIdentity, sleep: noWait });
    expect(versionReads(phasedSwitchedOn)).toHaveLength(2);
  });

  it('sleeps the configured interval once per unanswered poll, and stops after the configured attempts', async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const stuck = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [preparedLocalization()],
      submittedStates: ['READY_FOR_REVIEW'],
    });
    await expect(
      submitAppStoreRelease({
        request: stuck.request,
        ...releaseIdentity,
        sleep,
        pollAttempts: 3,
        pollIntervalMilliseconds: 1234,
      })
    ).rejects.toThrow(/still reads READY_FOR_REVIEW/);

    expect(sleep.mock.calls).toEqual([[1234], [1234], [1234]]);
    const submissionReads = stuck.calls.filter(
      (call) => call.method === 'GET' && call.path === '/reviewSubmissions/submission-new'
    );
    expect(submissionReads).toHaveLength(3);
  });

  it('stops polling as soon as the state reads WAITING_FOR_REVIEW, and never sleeps if the submit already says so', async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const settles = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [preparedLocalization()],
      submittedStates: ['READY_FOR_REVIEW', 'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW'],
    });
    const settled = await submitAppStoreRelease({
      request: settles.request,
      ...releaseIdentity,
      sleep,
      pollIntervalMilliseconds: 1234,
    });
    expect(settled.state).toBe('WAITING_FOR_REVIEW');
    expect(sleep.mock.calls).toEqual([[1234], [1234]]);

    const immediate = vi.fn(async (_milliseconds: number) => undefined);
    const answeredAtOnce = createFakeAppStoreConnect({
      versions: [preparedVersion()],
      localizations: [preparedLocalization()],
    });
    await submitAppStoreRelease({ request: answeredAtOnce.request, ...releaseIdentity, sleep: immediate });
    expect(immediate).not.toHaveBeenCalled();
  });
});

describe('a failed call names the fix', () => {
  const checkAgainst = (fake: FakeAppStoreConnect) =>
    checkAppStoreRelease({ request: fake.request, bundleId: BUNDLE_ID });

  it('blames the API key, not the role, for a 401', async () => {
    const fake = createFakeAppStoreConnect({ failWith: [{ prefix: 'GET /apps?', status: 401 }] });
    const message = await rejectionMessage(checkAgainst(fake));
    expect(message).toMatch(/rejected the API key \(401\) while trying to look up the app/);
    expect(message).not.toMatch(/App Manager/);
  });

  it('reports any other failure as the plain status it was', async () => {
    const fake = createFakeAppStoreConnect({ failWith: [{ prefix: 'GET /apps?', status: 500 }] });
    const message = await rejectionMessage(checkAgainst(fake));
    expect(message).toMatch(/Could not look up the app \(500\)/);
    expect(message).not.toMatch(/App Manager|rejected the API key/);
  });

  it('names the App Manager role for a 403, on a read as on a write', async () => {
    const fake = createFakeAppStoreConnect({ forbidden: ['GET /apps?'] });
    const message = await rejectionMessage(checkAgainst(fake));
    expect(message).toMatch(/refused to look up the app \(403\)/);
    expect(message).toMatch(/App Manager/);
  });
});

describe('checkAppStoreRelease: the empty store, a missing named version, and the extra reads', () => {
  const liveVersion = () =>
    editableVersion({
      id: 'version-live',
      versionString: '1.1.0',
      appVersionState: 'READY_FOR_DISTRIBUTION',
      releaseType: 'AFTER_APPROVAL',
      buildId: 'build-18',
      createdDate: '2026-10-12T04:00:00-07:00',
    });
  const olderVersion = () =>
    editableVersion({
      id: 'version-old',
      versionString: '1.0.0',
      appVersionState: 'REPLACED_WITH_NEW_VERSION',
      buildId: 'build-15',
      reviewDetail: null,
      createdDate: '2026-10-07T04:00:00-07:00',
    });
  const liveLocalization = () =>
    englishLocalization({ versionId: 'version-live', whatsNew: 'Command Terminals.', screenshotCount: 7 });
  const draftVersion = () =>
    editableVersion({ id: 'version-draft', versionString: '1.1.9', createdDate: '2026-10-14T00:00:00-07:00' });

  it('reports an empty store as a problem rather than throwing, and writes nothing', async () => {
    const fake = createFakeAppStoreConnect();
    const logged: string[] = [];
    const report = await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      log: (line: string) => logged.push(line),
    });
    expect(report).toEqual({
      versionString: null,
      state: null,
      releaseType: null,
      phasedReleaseState: null,
      reviewDetail: null,
      localizations: [],
      problems: ['No iOS App Store version exists yet.'],
      unreleased: [],
    });
    expect(logged).toContain('No iOS App Store version exists yet.');
    expect(writes(fake.calls)).toEqual([]);
  });

  it('says so, and inspects the newest version, when the named version does not exist yet', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [olderVersion(), liveVersion()],
      localizations: [liveLocalization()],
    });
    const logged: string[] = [];
    const report = await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      versionString: VERSION_STRING,
      log: (line: string) => logged.push(line),
    });
    expect(report.versionString).toBe('1.1.0');
    expect(logged.join('\n')).toContain(
      'Version 1.2.0 does not exist yet, so the newest version, 1.1.0, is inspected instead'
    );
  });

  it('does not claim a version is missing when none was named, or the named one was found', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [olderVersion(), liveVersion()],
      localizations: [liveLocalization()],
    });
    const unnamedLog: string[] = [];
    await checkAppStoreRelease({ request: fake.request, bundleId: BUNDLE_ID, log: (line: string) => unnamedLog.push(line) });
    expect(unnamedLog.join('\n')).not.toMatch(/does not exist yet/);

    const foundLog: string[] = [];
    await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      versionString: '1.0.0',
      log: (line: string) => foundLog.push(line),
    });
    expect(foundLog.join('\n')).not.toMatch(/does not exist yet/);
  });

  it('does not list the version being inspected as an unreleased one standing in its way', async () => {
    const fake = createFakeAppStoreConnect({ versions: [liveVersion(), draftVersion()] });
    const logged: string[] = [];
    const report = await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      versionString: '1.1.9',
      log: (line: string) => logged.push(line),
    });
    expect(report.versionString).toBe('1.1.9');
    expect(report.unreleased).toEqual(['1.1.9']);
    expect(logged.join('\n')).not.toMatch(/Unreleased version\(s\)/);
  });

  it('lists the other unreleased versions with their state, in review or waiting to release as well as drafts', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [
        liveVersion(),
        draftVersion(),
        editableVersion({
          id: 'version-waiting',
          versionString: '1.1.8',
          appVersionState: 'WAITING_FOR_REVIEW',
          createdDate: '2026-10-13T00:00:00-07:00',
        }),
      ],
    });
    const logged: string[] = [];
    const report = await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      versionString: '1.1.9',
      log: (line: string) => logged.push(line),
    });
    expect([...report.unreleased].sort()).toEqual(['1.1.8', '1.1.9']);
    const output = logged.join('\n');
    expect(output).toContain('Unreleased version(s): 1.1.8 (WAITING_FOR_REVIEW).');
    expect(output).not.toContain('1.1.9 (');
  });

  it('also reads the build query and the open review submissions the stages start with, and writes nothing', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [olderVersion(), liveVersion()],
      localizations: [liveLocalization()],
      reviewSubmissions: [
        { id: 'submission-open', state: 'READY_FOR_REVIEW', versionIds: [] },
        { id: 'submission-sent', state: 'WAITING_FOR_REVIEW', versionIds: [] },
      ],
    });
    const logged: string[] = [];
    await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      versionString: VERSION_STRING,
      log: (line: string) => logged.push(line),
    });

    const readPaths = fake.calls.filter((call) => call.method === 'GET').map((call) => call.path);
    // The build query is made for the NAMED version even though it does not
    // exist and another is inspected, and without a build number: the check has
    // none, and the filters are what a release depends on.
    expect(readPaths).toContain(
      '/builds?filter[app]=app-1&filter[preReleaseVersion.version]=1.2.0&filter[preReleaseVersion.platform]=IOS&limit=10'
    );
    expect(readPaths).toContain(
      '/apps/app-1/reviewSubmissions?filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,UNRESOLVED_ISSUES&limit=10'
    );
    // 200 is the API's page maximum, so the newest version is on the page.
    expect(readPaths.find((path) => path.startsWith('/apps/app-1/appStoreVersions?'))).toContain('limit=200');
    expect(logged.join('\n')).toContain('- Builds listed for 1.2.0: 1; open review submissions: 1.');
    expect(writes(fake.calls)).toEqual([]);
  });

  it('asks about the inspected version\'s builds when no version is named', async () => {
    const fake = createFakeAppStoreConnect({ versions: [olderVersion(), liveVersion()], localizations: [liveLocalization()] });
    await checkAppStoreRelease({ request: fake.request, bundleId: BUNDLE_ID });
    const buildsRead = fake.calls.find((call) => call.path.startsWith('/builds?'));
    expect(buildsRead).toBeDefined();
    expect(buildsRead?.path).toContain('filter[preReleaseVersion.version]=1.1.0');
    expect(buildsRead?.path).not.toContain('filter[version]');
  });

  it.each([
    { shape: 'included-only', where: 'only among the included resources' },
    { shape: 'linkage-only', where: 'only in each set\'s relationship linkage' },
  ] as const)('counts screenshots Apple reports $where', async ({ shape }) => {
    const fake = createFakeAppStoreConnect({
      versions: [liveVersion()],
      localizations: [{ ...liveLocalization(), screenshotCount: 3 }],
      screenshotShape: shape,
    });
    const report = await checkAppStoreRelease({ request: fake.request, bundleId: BUNDLE_ID });
    expect(report.localizations).toEqual([{ locale: 'en-US', hasWhatsNew: true, screenshotCount: 3 }]);
  });
});

describe('checkAppStoreRelease', () => {
  // The read-only preflight behind .github/workflows/app-store-check.yml. Its
  // whole value is that it can run on any day without touching App Store
  // Connect, so "no writes" is asserted in every case.
  const liveVersion = (overrides: Partial<FakeVersion> = {}) =>
    editableVersion({
      id: 'version-live',
      versionString: '1.1.0',
      appVersionState: 'READY_FOR_DISTRIBUTION',
      releaseType: 'AFTER_APPROVAL',
      buildId: 'build-18',
      createdDate: '2026-10-12T04:00:00-07:00',
      ...overrides,
    });
  const olderVersion = () =>
    editableVersion({
      id: 'version-old',
      versionString: '1.0.0',
      appVersionState: 'REPLACED_WITH_NEW_VERSION',
      releaseType: 'MANUAL',
      buildId: 'build-15',
      reviewDetail: null,
      createdDate: '2026-10-07T04:00:00-07:00',
    });
  const liveLocalization = () =>
    englishLocalization({ versionId: 'version-live', whatsNew: 'Command Terminals.', screenshotCount: 7 });

  it('inspects the newest version when none is named, and writes nothing', async () => {
    // The older version is listed first and has no review detail, so picking
    // the first entry instead of the newest would report it as missing.
    const fake = createFakeAppStoreConnect({
      versions: [olderVersion(), liveVersion()],
      localizations: [liveLocalization()],
    });
    const logged: string[] = [];
    const report = await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      versionString: '',
      log: (line: string) => logged.push(line),
    });
    expect(report.versionString).toBe('1.1.0');
    expect(report.reviewDetail).toEqual({ hasContact: true, hasNotes: true });
    expect(report.localizations).toEqual([{ locale: 'en-US', hasWhatsNew: true, screenshotCount: 7 }]);
    expect(report.problems).toEqual([]);
    expect(writes(fake.calls)).toEqual([]);
    expect(logged.join('\n')).toMatch(/Read-only: nothing was changed/);
  });

  it('inspects a named version and reports what would block its submission', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [olderVersion(), liveVersion()],
      localizations: [englishLocalization({ versionId: 'version-old', screenshotCount: 0 })],
    });
    const report = await checkAppStoreRelease({ request: fake.request, bundleId: BUNDLE_ID, versionString: '1.0.0' });
    expect(report.versionString).toBe('1.0.0');
    expect(report.problems.join('\n')).toMatch(/no App Review Information/);
    expect(report.problems.join('\n')).toMatch(/en-US has no screenshots/);
    expect(writes(fake.calls)).toEqual([]);
  });

  it('names an unreleased draft that would make stage 1 refuse', async () => {
    const fake = createFakeAppStoreConnect({
      versions: [liveVersion(), editableVersion({ id: 'version-draft', versionString: '1.1.9', createdDate: '2026-10-14T00:00:00-07:00' })],
      localizations: [liveLocalization()],
    });
    const logged: string[] = [];
    const report = await checkAppStoreRelease({
      request: fake.request,
      bundleId: BUNDLE_ID,
      log: (line: string) => logged.push(line),
    });
    expect(report.unreleased).toEqual(['1.1.9']);
    expect(logged.join('\n')).toMatch(/Unreleased version\(s\): 1\.1\.9 \(PREPARE_FOR_SUBMISSION\)/);
    expect(writes(fake.calls)).toEqual([]);
  });
});

describe('prepareAppStoreRelease.mjs command line', () => {
  // The exported stages are driven above through an injected request. These
  // cover the wrapper the workflows actually run: argument parsing, the real
  // transport (with fetch stubbed), the release notes reader, and the job
  // summary.
  const credentials = ['--key', 'key.p8', '--key-id', 'KEYID', '--issuer-id', 'issuer', '--bundle-id', BUNDLE_ID];

  it('requires the version and build number for the writing modes, but not for check', () => {
    expect(() => parseArguments([...credentials, '--mode', 'prepare', '--version', '1.2.0'])).toThrow(
      /--build-number/
    );
    expect(() => parseArguments([...credentials, '--mode', 'submit', '--build-number', '20'])).toThrow(/--version/);
    expect(parseArguments([...credentials, '--mode', 'check']).mode).toBe('check');
    expect(() => parseArguments([...credentials, '--mode', 'release'])).toThrow(/prepare, submit or check/);
    // Strict pairs: a bare flag would otherwise swallow the next flag as its value.
    expect(() => parseArguments([...credentials, '--mode'])).toThrow(/Malformed argument/);
  });

  describe('createRequest', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubFetch(status: number, text: string) {
      const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
      }));
      vi.stubGlobal('fetch', fetchStub);
      return fetchStub;
    }

    it('sends a JSON body with its content type, and a bearer token on every call', async () => {
      const fetchStub = stubFetch(200, '{"data":{"id":"x"}}');
      const request = createRequest(privateKeyPem, 'KEYID', 'issuer');
      const response = await request('PATCH', '/appStoreVersions/x', { data: { type: 'appStoreVersions' } });

      const [url, init] = fetchStub.mock.calls[0];
      expect(url).toBe('https://api.appstoreconnect.apple.com/v1/appStoreVersions/x');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe('{"data":{"type":"appStoreVersions"}}');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      expect(response).toEqual({ ok: true, status: 200, body: { data: { id: 'x' } } });
    });

    it('sends a GET with no body and no content type', async () => {
      const fetchStub = stubFetch(200, '{"data":[]}');
      await createRequest(privateKeyPem, 'KEYID', 'issuer')('GET', '/apps');
      const [, init] = fetchStub.mock.calls[0];
      expect(init.body).toBeUndefined();
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });

    it('reads an empty 204 as an empty body, and keeps a non-JSON error page readable', async () => {
      // DELETE answers 204 with no body; JSON.parse('') would throw.
      stubFetch(204, '');
      expect(await createRequest(privateKeyPem, 'KEYID', 'issuer')('DELETE', '/x')).toEqual({
        ok: true,
        status: 204,
        body: {},
      });

      stubFetch(502, '<html>Bad Gateway</html>');
      expect(await createRequest(privateKeyPem, 'KEYID', 'issuer')('GET', '/x')).toEqual({
        ok: false,
        status: 502,
        body: { raw: '<html>Bad Gateway</html>' },
      });
    });
  });

  it('reads release notes by locale, and reports a missing locale as undefined', () => {
    const directory = mkdtempSync(join(tmpdir(), 'whatsnew-'));
    writeFileSync(join(directory, 'whatsnew-en-US'), RELEASE_NOTES);
    const readWhatsNew = readWhatsNewFrom(directory);
    expect(readWhatsNew('en-US')).toBe(RELEASE_NOTES);
    expect(readWhatsNew('de-DE')).toBeUndefined();
  });

  it('appends the report to the job summary, and does nothing outside Actions', () => {
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'summary-')), 'summary.md');
    writeFileSync(summaryPath, '');
    appendStepSummary(summaryPath, 'prepare', ['App Store version 1.2.0: PREPARE_FOR_SUBMISSION']);
    expect(readFileSync(summaryPath, 'utf8')).toBe(
      '### App Store version (prepare)\n\nApp Store version 1.2.0: PREPARE_FOR_SUBMISSION\n\n'
    );
    expect(() => appendStepSummary(undefined, 'prepare', ['ignored'])).not.toThrow();
  });

  it('leaves the job summary untouched when a stage logged nothing', () => {
    // A stage that fails before its first log line has nothing to report, and a
    // bare header over an empty body would read as a report with no findings.
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'summary-')), 'summary.md');
    writeFileSync(summaryPath, 'an earlier step\n');
    appendStepSummary(summaryPath, 'prepare', []);
    expect(readFileSync(summaryPath, 'utf8')).toBe('an earlier step\n');
  });

  describe('main', () => {
    // Every case passes an explicit summaryPath. The default is
    // process.env.GITHUB_STEP_SUMMARY, which IS set when CI runs this file, so
    // leaving it out would write into the real job summary.
    const KEY_TEXT = 'not-a-real-private-key';
    const NOTES_FROM_THE_FLAG = 'Notes read from the directory the flag named.';

    function createMainHarness(seed: FakeSeed = {}) {
      const directory = mkdtempSync(join(tmpdir(), 'asc-main-'));
      const keyPath = join(directory, 'AuthKey.p8');
      writeFileSync(keyPath, KEY_TEXT);
      const notesDirectory = join(directory, 'notes');
      mkdirSync(notesDirectory);
      writeFileSync(join(notesDirectory, 'whatsnew-en-US'), `${NOTES_FROM_THE_FLAG}\n`);
      const summaryPath = join(directory, 'summary.md');
      writeFileSync(summaryPath, '');

      const fake = createFakeAppStoreConnect(seed);
      const makeRequest = vi.fn((_privateKeyPem: string, _keyId: string, _issuerId: string) => fake.request);
      const written: string[] = [];
      return {
        fake,
        makeRequest,
        written,
        notesDirectory,
        readSummary: () => readFileSync(summaryPath, 'utf8'),
        dependencies: {
          makeRequest,
          summaryPath,
          write: (text: string) => {
            written.push(text);
          },
        },
        credentials: ['--key', keyPath, '--key-id', 'KEYID', '--issuer-id', 'issuer', '--bundle-id', BUNDLE_ID],
      };
    }

    const releaseArguments = ['--version', VERSION_STRING, '--build-number', BUILD_NUMBER];

    it('prepare: reads the key, creates the version, takes What\'s New from --whatsnew-dir, and writes the summary', async () => {
      const harness = createMainHarness();
      await main(
        [...harness.credentials, '--mode', 'prepare', ...releaseArguments, '--whatsnew-dir', harness.notesDirectory],
        harness.dependencies
      );

      expect(harness.makeRequest).toHaveBeenCalledWith(KEY_TEXT, 'KEYID', 'issuer');
      expect(harness.fake.calls).toContainEqual(expect.objectContaining({ method: 'POST', path: '/appStoreVersions' }));
      // The repository's own store/whatsnew has an en-US file too, so only the
      // sentinel text proves the flag, not the default, was read.
      expect(harness.fake.localizations[0].whatsNew).toBe(NOTES_FROM_THE_FLAG);
      expect(harness.written.join('')).toContain('Created App Store version 1.2.0.\n');
      expect(harness.readSummary()).toContain('### App Store version (prepare)\n\n');
      expect(harness.readSummary()).toContain('Created App Store version 1.2.0.');
    });

    it('submit: submits the prepared version for review', async () => {
      const harness = createMainHarness({ versions: [preparedVersion()], localizations: [preparedLocalization()] });
      await main([...harness.credentials, '--mode', 'submit', ...releaseArguments], harness.dependencies);

      expect(harness.fake.calls).toContainEqual(
        expect.objectContaining({ method: 'PATCH', path: '/reviewSubmissions/submission-new' })
      );
      expect(harness.written.join('')).toContain('Submitted for App Review (WAITING_FOR_REVIEW)');
      expect(harness.readSummary()).toContain('### App Store version (submit)\n\n');
    });

    it('check: passes --version through, writes nothing, and needs no build number', async () => {
      const olderThanNewest = editableVersion({
        id: 'version-old',
        versionString: '1.0.0',
        appVersionState: 'REPLACED_WITH_NEW_VERSION',
        buildId: 'build-15',
        createdDate: '2026-10-07T04:00:00-07:00',
      });
      const newest = editableVersion({
        id: 'version-live',
        versionString: '1.1.0',
        appVersionState: 'READY_FOR_DISTRIBUTION',
        releaseType: 'AFTER_APPROVAL',
        buildId: 'build-18',
        createdDate: '2026-10-12T04:00:00-07:00',
      });
      // The named version is the OLDER one, so ignoring --version would inspect 1.1.0.
      const named = createMainHarness({ versions: [olderThanNewest, newest] });
      await main([...named.credentials, '--mode', 'check', '--version', '1.0.0'], named.dependencies);
      expect(named.written.join('')).toContain('Inspected version 1.0.0: REPLACED_WITH_NEW_VERSION');
      expect(writes(named.fake.calls)).toEqual([]);
      expect(named.readSummary()).toContain('### App Store version (check)\n\n');

      const unnamed = createMainHarness({ versions: [olderThanNewest, newest] });
      await main([...unnamed.credentials, '--mode', 'check'], unnamed.dependencies);
      expect(unnamed.written.join('')).toContain('Inspected version 1.1.0: READY_FOR_DISTRIBUTION');
    });

    it('still appends what was logged to the job summary when the stage fails', async () => {
      // The report is what a human reads before the second approval, and a
      // failing stage is exactly when they need it. Fail AFTER a line is logged
      // ("Created ..."): a stage with nothing logged appends nothing either way.
      const harness = createMainHarness({ forbidden: ['PATCH /appStoreVersionLocalizations/'] });
      await expect(
        main(
          [...harness.credentials, '--mode', 'prepare', ...releaseArguments, '--whatsnew-dir', harness.notesDirectory],
          harness.dependencies
        )
      ).rejects.toThrow(/App Manager/);

      expect(harness.fake.calls).toContainEqual(
        expect.objectContaining({ method: 'PATCH', path: '/appStoreVersionLocalizations/localization-new-0' })
      );
      expect(harness.readSummary()).toContain('### App Store version (prepare)\n\n');
      expect(harness.readSummary()).toContain('Created App Store version 1.2.0.');
    });

    it('exits 1 with the reason on stderr when the command line is wrong, before any network call', () => {
      const result = spawnSync(
        process.execPath,
        [join(repositoryRoot, 'scripts', 'prepareAppStoreRelease.mjs'), '--mode', 'bogus'],
        { cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' }, timeout: 30_000 }
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--mode must be prepare, submit or check, not "bogus"');
    });
  });
});
