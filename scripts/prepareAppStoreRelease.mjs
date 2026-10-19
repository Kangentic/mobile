#!/usr/bin/env node
/**
 * Prepares, and then submits for App Review, the App Store version of a release
 * that reaches every user the moment Apple approves it.
 *
 * Two stages, run by two jobs in .github/workflows/build-ios.yml, each behind its
 * own approval of the app-store-connect environment, plus a read-only check:
 *
 *   --mode prepare  runs once Apple has accepted the build. It creates or updates
 *                   the App Store version for this release, attaches the build,
 *                   fills What's New from store/whatsnew/, sets releaseType
 *                   AFTER_APPROVAL, cancels any planned phased release, and
 *                   carries the App Review Information over from the newest
 *                   version that has it complete when this one lacks it.
 *   --mode submit   runs after the second approval. It re-applies those
 *                   guarantees, refuses if the review notes or screenshots are
 *                   missing, and submits the version for App Review.
 *   --mode check    writes nothing. It reports what the two stages would find,
 *                   as a preflight before a release day, run by
 *                   .github/workflows/app-store-check.yml (see checkAppStoreRelease).
 *
 * The gap between the stages is deliberate. It is where a human updates the
 * listing screenshots, which this script never touches.
 *
 * "100% every time" (maintainer decision, 2026-10-15) is two settings, and both
 * are enforced here rather than left to a radio button in App Store Connect:
 *
 *   - releaseType AFTER_APPROVAL: the version goes live as soon as App Review
 *     approves it, with no manual Release step.
 *   - no appStoreVersionPhasedRelease: a phased release spreads automatic updates
 *     over 7 days. A version without one is what App Store Connect shows as
 *     "Release update to all users immediately". Phased release only ever gates
 *     automatic updates; a manual update from the App Store is never held back.
 *
 * Creating versions and review submissions needs an API key with the App Manager
 * (or Admin) role. A key without it gets a bare 403, which is translated below
 * into the role it is missing.
 *
 * No dependencies, like scripts/checkAppStoreBuild.mjs, whose token helper this
 * reuses. The App Store Connect calls are made through an injected `request`, so
 * tests/unit/prepareAppStoreRelease.test.ts drives every mode with no network.
 *
 * Usage:
 *   node scripts/prepareAppStoreRelease.mjs \
 *     --key <AuthKey.p8> --key-id <kid> --issuer-id <iss> \
 *     --bundle-id <com.example.app> --version <1.2.3> --build-number <n> \
 *     --mode <prepare|submit> [--whatsnew-dir store/whatsnew]
 *
 *   node scripts/prepareAppStoreRelease.mjs \
 *     --key <AuthKey.p8> --key-id <kid> --issuer-id <iss> \
 *     --bundle-id <com.example.app> --mode check [--version <1.2.3>]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createAppStoreConnectToken } from './checkAppStoreBuild.mjs';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1';

const FULL_RELEASE_TYPE = 'AFTER_APPROVAL';

/**
 * @typedef {{ ok: boolean, status: number, body: unknown }} AppStoreConnectResponse
 * @typedef {(method: string, apiPath: string, body?: unknown) => Promise<AppStoreConnectResponse>} AppStoreConnectRequest
 * @typedef {{ hasContact: boolean, hasNotes: boolean }} ReviewDetailSummary
 * @typedef {{ locale: string, hasWhatsNew: boolean, screenshotCount: number }} LocalizationSummary
 * @typedef {{
 *   versionString: string,
 *   buildNumber: string,
 *   state: string,
 *   alreadyDone: boolean,
 *   changes: string[],
 *   reviewDetail: ReviewDetailSummary | null,
 *   localizations: LocalizationSummary[],
 *   problems: string[],
 * }} ReleaseReport
 */

/**
 * Version states in which the build, metadata and release settings can still
 * change. READY_FOR_REVIEW is a version added to a review submission that has not
 * been submitted yet, so it is still a draft.
 */
export const EDITABLE_VERSION_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_REVIEW',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

/** Version states in which the version is already with App Review. */
export const SUBMITTED_VERSION_STATES = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);

/**
 * Version states that hold the one unreleased version Apple allows per platform:
 * every draft, plus a version with App Review or approved and waiting for its
 * release. Never a live or replaced state, or the live version would refuse every
 * release that follows it.
 */
const UNRELEASED_VERSION_STATES = new Set([
  ...EDITABLE_VERSION_STATES,
  ...SUBMITTED_VERSION_STATES,
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
]);

/**
 * Version states past review: approved, releasing, or live. READY_FOR_SALE and
 * PROCESSING_FOR_APP_STORE are the deprecated `appStoreState` spellings, kept for
 * the fallback read below.
 */
const PAST_REVIEW_VERSION_STATES = new Set([
  'ACCEPTED',
  'PENDING_APPLE_RELEASE',
  'PENDING_DEVELOPER_RELEASE',
  'PROCESSING_FOR_DISTRIBUTION',
  'READY_FOR_DISTRIBUTION',
  'REPLACED_WITH_NEW_VERSION',
  'READY_FOR_SALE',
  'PROCESSING_FOR_APP_STORE',
]);

/** Review submissions that exist but have not been sent to App Review yet. */
const OPEN_REVIEW_SUBMISSION_STATES = ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'];

/** Review submission states that mean the submit landed. */
const SUBMITTED_REVIEW_SUBMISSION_STATES = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);

function describeApiErrors(body) {
  if (!Array.isArray(body?.errors)) return JSON.stringify(body);
  return body.errors.map((error) => `${error.title}: ${error.detail ?? ''}`.trim()).join('; ');
}

/**
 * Turns a failed call into a message that names the fix. A 403 is the one that
 * matters most: it is what an upload-only key gets the first time this runs, and
 * Apple's own body does not say which role is missing.
 */
export function describeFailure(response, purpose) {
  const detail = describeApiErrors(response.body);
  if (response.status === 401) {
    return (
      `App Store Connect rejected the API key (401) while trying to ${purpose}. Check that ASC_KEY_ID ` +
      `and ASC_ISSUER_ID match the .p8 and that the key has not been revoked. Detail: ${detail}`
    );
  }
  if (response.status === 403) {
    return (
      `App Store Connect refused to ${purpose} (403). Creating and submitting App Store versions needs ` +
      'an API key with the App Manager (or Admin) role: App Store Connect > Users and Access > ' +
      `Integrations. Detail: ${detail}`
    );
  }
  return `Could not ${purpose} (${response.status}): ${detail}`;
}

async function callApi(request, method, apiPath, body, purpose) {
  const response = await request(method, apiPath, body);
  if (!response.ok) {
    throw new Error(describeFailure(response, purpose));
  }
  return response.body ?? {};
}

async function findAppId(request, bundleId) {
  const apps = await callApi(
    request,
    'GET',
    `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`,
    undefined,
    'look up the app'
  );
  const app = apps.data?.[0];
  if (!app) {
    throw new Error(`App Store Connect has no app with bundle id ${bundleId}.`);
  }
  return app.id;
}

/**
 * The build query both stages make, and the check mode makes without a build
 * number, so the preflight exercises the same filters a release depends on.
 */
function buildsPath(appId, versionString, buildNumber) {
  const buildFilter = buildNumber === undefined ? '' : `&filter[version]=${encodeURIComponent(buildNumber)}`;
  return (
    `/builds?filter[app]=${appId}${buildFilter}` +
    `&filter[preReleaseVersion.version]=${encodeURIComponent(versionString)}` +
    '&filter[preReleaseVersion.platform]=IOS&limit=10'
  );
}

/** The open review submissions the submit stage starts from, also read by the check mode. */
function openReviewSubmissionsPath(appId) {
  return (
    `/apps/${appId}/reviewSubmissions?filter[platform]=IOS` +
    `&filter[state]=${OPEN_REVIEW_SUBMISSION_STATES.join(',')}&limit=10`
  );
}

/**
 * The build this release ships. Required to be VALID: an App Store version will
 * accept an attached build that is still processing, and App Review then fails
 * it, so the check belongs here rather than in a rejection days later.
 */
async function findValidBuildId(request, appId, versionString, buildNumber) {
  const builds = await callApi(
    request,
    'GET',
    buildsPath(appId, versionString, buildNumber),
    undefined,
    'list builds'
  );
  const build = (builds.data ?? []).find((candidate) => candidate.attributes?.version === buildNumber);
  if (!build) {
    throw new Error(
      `No build ${buildNumber} for version ${versionString} on App Store Connect. The upload has to land, ` +
        'and Apple has to accept it, before the App Store version can use it.'
    );
  }
  const state = build.attributes?.processingState;
  if (state !== 'VALID') {
    throw new Error(
      `Build ${buildNumber} is ${state ?? 'in an unknown state'}, not VALID, so it cannot be attached to ` +
        'an App Store version yet.'
    );
  }
  return build.id;
}

function summarizeReviewDetail(attributes) {
  // Presence only. The notes carry the reviewer demo pairing code and the detail
  // can carry a demo password, so no value from this resource is ever logged.
  return {
    hasContact: Boolean(
      attributes?.contactFirstName &&
        attributes?.contactLastName &&
        attributes?.contactPhone &&
        attributes?.contactEmail
    ),
    hasNotes: typeof attributes?.notes === 'string' && attributes.notes.trim().length > 0,
  };
}

/**
 * Every iOS version, with the same `include`s as a single-version read. 200 is
 * the API's page maximum; the order Apple lists versions in is not documented,
 * so a caller looking for the newest sorts by createdDate itself.
 */
function versionsListPath(appId) {
  return (
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS` +
    '&include=build,appStoreVersionPhasedRelease,appStoreReviewDetail&limit=200'
  );
}

/**
 * Reads this release's App Store version, with the build, phased release and
 * review detail it links to, or null when there is none. Read through `include`
 * rather than the phased release's own endpoint, because Apple does not document
 * what that endpoint answers for a version with no phased release, while a null
 * relationship linkage is unambiguous.
 */
async function readVersion(request, appId, versionString) {
  const response = await callApi(
    request,
    'GET',
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${encodeURIComponent(versionString)}` +
      '&include=build,appStoreVersionPhasedRelease,appStoreReviewDetail&limit=10',
    undefined,
    'read the App Store version'
  );
  const resource = (response.data ?? []).find(
    (candidate) => candidate.attributes?.versionString === versionString
  );
  return resource ? parseVersionResource(resource, response.included ?? []) : null;
}

function parseVersionResource(resource, included) {
  const findIncluded = (linkage) =>
    linkage ? included.find((item) => item.type === linkage.type && item.id === linkage.id) : undefined;

  const phasedLinkage = resource.relationships?.appStoreVersionPhasedRelease?.data ?? null;
  const reviewLinkage = resource.relationships?.appStoreReviewDetail?.data ?? null;
  const reviewDetail = findIncluded(reviewLinkage);

  return {
    id: resource.id,
    versionString: resource.attributes?.versionString,
    createdDate: resource.attributes?.createdDate ?? '',
    // appStoreState is deprecated in favour of appVersionState; read the new one
    // first and fall back so an older response still classifies.
    state: resource.attributes?.appVersionState ?? resource.attributes?.appStoreState ?? 'UNKNOWN',
    releaseType: resource.attributes?.releaseType,
    buildId: resource.relationships?.build?.data?.id ?? null,
    phasedRelease: phasedLinkage
      ? {
          id: phasedLinkage.id,
          state: findIncluded(phasedLinkage)?.attributes?.phasedReleaseState ?? 'UNKNOWN',
        }
      : null,
    reviewDetail: reviewDetail ? summarizeReviewDetail(reviewDetail.attributes) : null,
    reviewDetailId: reviewLinkage?.id ?? null,
    // The raw attributes, held only so stage 1 can copy them onto a new version.
    // Never logged or reported: the notes carry the demo pairing code.
    reviewDetailAttributes: reviewDetail?.attributes ?? null,
  };
}

/**
 * What to do with an existing version: 'editable' to carry on, 'done' when a
 * re-run finds this exact build already submitted or approved, or a thrown error
 * naming what a human has to do.
 */
function classifyExistingVersion(version, versionString, buildId) {
  if (EDITABLE_VERSION_STATES.has(version.state)) return 'editable';
  const sameBuild = version.buildId === buildId;
  if (SUBMITTED_VERSION_STATES.has(version.state)) {
    if (sameBuild) return 'done';
    throw new Error(
      `Version ${versionString} is already ${version.state} with a different build. Remove it from review ` +
        'in App Store Connect first, then re-run.'
    );
  }
  if (PAST_REVIEW_VERSION_STATES.has(version.state)) {
    if (sameBuild) return 'done';
    throw new Error(
      `Version ${versionString} is already ${version.state}. An App Store release needs a new version ` +
        'string: bump `version` in app.config.ts and release again.'
    );
  }
  throw new Error(
    `Version ${versionString} is ${version.state}, which this script does not know how to move on from. ` +
      'Finish it in App Store Connect.'
  );
}

/**
 * Apple allows one unreleased version per platform, so another version string
 * left in draft, in review, or approved and waiting to release would make the
 * create fail with an opaque conflict. Named here instead.
 */
async function refuseOtherUnreleasedVersion(request, appId, versionString) {
  const unreleased = await callApi(
    request,
    'GET',
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS` +
      `&filter[appVersionState]=${[...UNRELEASED_VERSION_STATES].join(',')}&limit=10`,
    undefined,
    'list unreleased App Store versions'
  );
  const other = (unreleased.data ?? []).find((candidate) => candidate.attributes?.versionString !== versionString);
  if (!other) return;
  const otherVersionString = other.attributes?.versionString;
  const otherState = other.attributes?.appVersionState ?? other.attributes?.appStoreState;
  if (EDITABLE_VERSION_STATES.has(otherState)) {
    throw new Error(
      `App Store Connect already has an unreleased iOS version ${otherVersionString}. Apple ` +
        `allows one at a time, so version ${versionString} cannot be created next to it. Delete that draft, ` +
        'or release under its version string, then re-run.'
    );
  }
  throw new Error(
    `App Store Connect already has iOS version ${otherVersionString} in ${otherState}. Apple allows one ` +
      `unreleased version at a time, so version ${versionString} cannot be created until that one is ` +
      'released. Wait for it, or withdraw it from review in App Store Connect, then re-run.'
  );
}

async function createVersion(request, appId, versionString) {
  await callApi(
    request,
    'POST',
    '/appStoreVersions',
    {
      data: {
        type: 'appStoreVersions',
        attributes: { platform: 'IOS', versionString, releaseType: FULL_RELEASE_TYPE },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    },
    `create App Store version ${versionString}`
  );
}

/**
 * The two "100%" settings plus the build. Shared by both stages, because the
 * submit stage cannot trust that nobody changed them in App Store Connect while
 * the second approval was pending. Returns what it changed, for the log.
 */
async function enforceFullRelease(request, version, buildId) {
  const changes = [];

  if (version.releaseType !== FULL_RELEASE_TYPE) {
    await callApi(
      request,
      'PATCH',
      `/appStoreVersions/${version.id}`,
      { data: { type: 'appStoreVersions', id: version.id, attributes: { releaseType: FULL_RELEASE_TYPE } } },
      'set the version to release automatically after approval'
    );
    changes.push(`releaseType ${version.releaseType ?? 'unset'} -> ${FULL_RELEASE_TYPE}`);
  }

  if (version.buildId !== buildId) {
    await callApi(
      request,
      'PATCH',
      `/appStoreVersions/${version.id}/relationships/build`,
      { data: { type: 'builds', id: buildId } },
      'attach the build to the version'
    );
    changes.push('attached this build');
  }

  if (version.phasedRelease) {
    // Only a phased release that has not started can be cancelled. On a version
    // that has not been released, any other state means something unexpected
    // happened, so stop rather than guess.
    if (version.phasedRelease.state !== 'INACTIVE') {
      throw new Error(
        `The version has a phased release in state ${version.phasedRelease.state}, which cannot be ` +
          'cancelled. Use Release to All Users in App Store Connect.'
      );
    }
    await callApi(
      request,
      'DELETE',
      `/appStoreVersionPhasedReleases/${version.phasedRelease.id}`,
      undefined,
      'cancel the planned phased release'
    );
    changes.push('cancelled the planned 7-day phased release');
  }

  return changes;
}

/**
 * The App Review Information fields a new version takes from an earlier one.
 * The contact details and the notes are what stage 2 refuses without; the demo
 * account fields come along so the copy matches its source.
 */
const REVIEW_DETAIL_FIELDS = [
  'contactFirstName',
  'contactLastName',
  'contactPhone',
  'contactEmail',
  'demoAccountName',
  'demoAccountPassword',
  'demoAccountRequired',
  'notes',
];

function isBlankField(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim().length === 0);
}

function hasCompleteReviewDetail(version) {
  return Boolean(version.reviewDetail?.hasContact && version.reviewDetail?.hasNotes);
}

/**
 * Apple does not document whether a version created through the API inherits
 * the previous version's App Review Information, and without it stage 2
 * refuses, which would stop a release for a human to retype details App Store
 * Connect already holds. So every field this version lacks is copied from the
 * newest other iOS version whose details are complete. A field already set is
 * never overwritten, and only field names reach the log.
 */
async function carryOverReviewDetail(request, appId, version) {
  if (hasCompleteReviewDetail(version)) return [];

  const response = await callApi(request, 'GET', versionsListPath(appId), undefined, 'list the App Store versions');
  const included = response.included ?? [];
  const source = (response.data ?? [])
    .map((resource) => parseVersionResource(resource, included))
    .filter((candidate) => candidate.id !== version.id && hasCompleteReviewDetail(candidate))
    .sort((first, second) => second.createdDate.localeCompare(first.createdDate))[0];
  if (!source) return [];

  const current = version.reviewDetailAttributes ?? {};
  const attributes = Object.fromEntries(
    REVIEW_DETAIL_FIELDS.filter(
      (field) => isBlankField(current[field]) && !isBlankField(source.reviewDetailAttributes[field])
    ).map((field) => [field, source.reviewDetailAttributes[field]])
  );
  const copiedFields = Object.keys(attributes);
  if (copiedFields.length === 0) return [];

  const purpose = `carry the App Review Information over from version ${source.versionString}`;
  if (version.reviewDetailId) {
    await callApi(
      request,
      'PATCH',
      `/appStoreReviewDetails/${version.reviewDetailId}`,
      { data: { type: 'appStoreReviewDetails', id: version.reviewDetailId, attributes } },
      purpose
    );
  } else {
    await callApi(
      request,
      'POST',
      '/appStoreReviewDetails',
      {
        data: {
          type: 'appStoreReviewDetails',
          attributes,
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } } },
        },
      },
      purpose
    );
  }
  return [`App Review Information carried over from version ${source.versionString} (${copiedFields.join(', ')})`];
}

async function readLocalizations(request, versionId) {
  const response = await callApi(
    request,
    'GET',
    `/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`,
    undefined,
    'list the version localizations'
  );
  return (response.data ?? []).map((localization) => ({
    id: localization.id,
    locale: localization.attributes?.locale,
    whatsNew: localization.attributes?.whatsNew ?? '',
  }));
}

/**
 * Apple marks this endpoint deprecated as of API 4.5 in favour of the asset
 * library placements, but it still answers, and it is the one that reflects the
 * screenshots Media Manager shows. If it is ever removed, this read fails loudly
 * through callApi rather than reporting zero.
 */
async function countScreenshots(request, localizationId) {
  const response = await callApi(
    request,
    'GET',
    `/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?include=appScreenshots&limit=50&limit[appScreenshots]=50`,
    undefined,
    'list the screenshot sets'
  );
  const linked = (response.data ?? []).reduce(
    (total, screenshotSet) => total + (screenshotSet.relationships?.appScreenshots?.data?.length ?? 0),
    0
  );
  const included = (response.included ?? []).filter((item) => item.type === 'appScreenshots').length;
  return Math.max(linked, included);
}

async function describeLocalizations(request, versionId) {
  const localizations = await readLocalizations(request, versionId);
  return Promise.all(
    localizations.map(async (localization) => ({
      locale: localization.locale,
      hasWhatsNew: localization.whatsNew.trim().length > 0,
      screenshotCount: await countScreenshots(request, localization.id),
    }))
  );
}

/** The read-back after a write: proof the settings stuck, not that the calls returned 200. */
async function verifyFullRelease(request, appId, versionString, buildId) {
  const version = await readVersion(request, appId, versionString);
  const problems = [];
  if (!version) problems.push('the version is missing');
  else {
    if (version.releaseType !== FULL_RELEASE_TYPE) problems.push(`releaseType is ${version.releaseType}`);
    if (version.phasedRelease) problems.push('a phased release is still attached');
    if (version.buildId !== buildId) problems.push('the build is not attached');
  }
  if (problems.length > 0) {
    throw new Error(`App Store Connect did not keep the full-release settings: ${problems.join('; ')}.`);
  }
  return version;
}

function readinessProblems(reviewDetail, localizations) {
  const problems = [];
  if (!reviewDetail) {
    problems.push(
      'The version has no App Review Information (contact details, and the notes that carry the demo pairing code).'
    );
  } else {
    if (!reviewDetail.hasContact) {
      problems.push('The App Review contact details are incomplete (first and last name, phone, email).');
    }
    if (!reviewDetail.hasNotes) {
      problems.push(
        'The App Review notes are empty. Reviewers need the demo pairing code there to get past pairing ' +
          '(App Review 2.1(a)).'
      );
    }
  }
  if (localizations.length === 0) {
    problems.push('The version has no localizations.');
  }
  for (const localization of localizations) {
    if (localization.screenshotCount === 0) problems.push(`${localization.locale} has no screenshots.`);
    if (!localization.hasWhatsNew) problems.push(`${localization.locale} has no What's New text.`);
  }
  return problems;
}

/**
 * @param {ReviewDetailSummary | null} reviewDetail
 * @returns {string}
 */
function describeReviewDetailLine(reviewDetail) {
  if (!reviewDetail) return '- App Review Information: MISSING.';
  return (
    `- App Review contact details: ${reviewDetail.hasContact ? 'present' : 'MISSING'}; ` +
    `review notes: ${reviewDetail.hasNotes ? 'present' : 'MISSING'}.`
  );
}

/**
 * @param {LocalizationSummary} localization
 * @returns {string}
 */
function describeLocalizationLine(localization) {
  return (
    `- ${localization.locale}: ${localization.screenshotCount} screenshot(s), What's New ` +
    `${localization.hasWhatsNew ? 'set' : 'MISSING'}.`
  );
}

/**
 * Report lines for the log and the job summary. Booleans and counts only.
 *
 * @param {ReleaseReport} report
 * @returns {string[]}
 */
export function formatReport(report) {
  const lines = [
    `App Store version ${report.versionString}: ${report.state}`,
    '- Releases automatically after approval, to all users at once (no phased release).',
    `- Build ${report.buildNumber} attached.`,
  ];
  for (const change of report.changes) lines.push(`- Changed: ${change}.`);
  lines.push(describeReviewDetailLine(report.reviewDetail));
  if (report.localizations.length === 0) lines.push('- Localizations: NONE.');
  for (const localization of report.localizations) lines.push(describeLocalizationLine(localization));
  return lines;
}

const noLog = () => {};

/** @returns {ReleaseReport} */
function alreadyDoneReport(versionString, buildNumber, state) {
  return {
    versionString,
    buildNumber,
    state,
    alreadyDone: true,
    changes: [],
    reviewDetail: null,
    localizations: [],
    problems: [],
  };
}

/**
 * Stage 1. Creates or updates the version, attaches the build, fills What's
 * New, enforces the full-release settings, and carries over App Review
 * Information the version lacks. Never fails on missing review notes or
 * screenshots: it reports them, because fixing them is exactly what the gap
 * before the second approval is for.
 *
 * @param {{
 *   request: AppStoreConnectRequest,
 *   bundleId: string,
 *   versionString: string,
 *   buildNumber: string,
 *   readWhatsNew: (locale: string) => string | undefined,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<ReleaseReport>}
 */
export async function prepareAppStoreRelease({
  request,
  bundleId,
  versionString,
  buildNumber,
  readWhatsNew,
  log = noLog,
}) {
  const appId = await findAppId(request, bundleId);
  const buildId = await findValidBuildId(request, appId, versionString, buildNumber);

  let version = await readVersion(request, appId, versionString);
  if (version && classifyExistingVersion(version, versionString, buildId) === 'done') {
    log(`Version ${versionString} is already ${version.state} with build ${buildNumber}; nothing to prepare.`);
    return alreadyDoneReport(versionString, buildNumber, version.state);
  }

  if (!version) {
    await refuseOtherUnreleasedVersion(request, appId, versionString);
    await createVersion(request, appId, versionString);
    log(`Created App Store version ${versionString}.`);
    version = await readVersion(request, appId, versionString);
    if (!version) {
      throw new Error(`App Store version ${versionString} was created but could not be read back.`);
    }
  }

  const changes = await enforceFullRelease(request, version, buildId);
  changes.push(...(await carryOverReviewDetail(request, appId, version)));

  // Every locale is checked before any is written, so a missing file fails the
  // stage without leaving half the localizations updated. Trailing whitespace is
  // trimmed: Play is sent the file as it is, but a stray newline renders as a
  // blank line in the App Store's What's New.
  const localizations = await readLocalizations(request, version.id);
  const missingLocales = localizations
    .filter((localization) => readWhatsNew(localization.locale) === undefined)
    .map((localization) => localization.locale);
  if (missingLocales.length > 0) {
    throw new Error(
      `No release notes for ${missingLocales.join(', ')}. Apple requires What's New for every ` +
        'localization of an update: add store/whatsnew/whatsnew-<locale> for each one.'
    );
  }
  for (const localization of localizations) {
    const whatsNew = readWhatsNew(localization.locale).trimEnd();
    if (localization.whatsNew !== whatsNew) {
      await callApi(
        request,
        'PATCH',
        `/appStoreVersionLocalizations/${localization.id}`,
        {
          data: { type: 'appStoreVersionLocalizations', id: localization.id, attributes: { whatsNew } },
        },
        `set What's New for ${localization.locale}`
      );
      changes.push(`What's New set for ${localization.locale}`);
    }
  }

  const verified = await verifyFullRelease(request, appId, versionString, buildId);
  const localizationSummaries = await describeLocalizations(request, verified.id);
  /** @type {ReleaseReport} */
  const report = {
    versionString,
    buildNumber,
    state: verified.state,
    alreadyDone: false,
    changes,
    reviewDetail: verified.reviewDetail,
    localizations: localizationSummaries,
    problems: readinessProblems(verified.reviewDetail, localizationSummaries),
  };
  for (const line of formatReport(report)) log(line);
  for (const problem of report.problems) log(`Needs attention before submitting: ${problem}`);
  return report;
}

async function findOrCreateReviewSubmission(request, appId) {
  const open = await callApi(
    request,
    'GET',
    openReviewSubmissionsPath(appId),
    undefined,
    'list open review submissions'
  );
  const existing = open.data?.[0];
  if (existing) return existing.id;

  const created = await callApi(
    request,
    'POST',
    '/reviewSubmissions',
    {
      data: {
        type: 'reviewSubmissions',
        attributes: { platform: 'IOS' },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    },
    'create a review submission'
  );
  return created.data.id;
}

async function ensureSubmissionItem(request, submissionId, versionId) {
  const items = await callApi(
    request,
    'GET',
    `/reviewSubmissions/${submissionId}/items?include=appStoreVersion&limit=50`,
    undefined,
    'list the review submission items'
  );
  const alreadyAdded = (items.data ?? []).some(
    (item) => item.relationships?.appStoreVersion?.data?.id === versionId
  );
  if (alreadyAdded) return;
  await callApi(
    request,
    'POST',
    '/reviewSubmissionItems',
    {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    },
    'add the version to the review submission'
  );
}

/**
 * Stage 2. Re-applies the full-release settings, refuses an incomplete version,
 * then submits it and waits until App Store Connect reports it as waiting for
 * review. A re-run on a version already submitted with this build is a no-op.
 *
 * @param {{
 *   request: AppStoreConnectRequest,
 *   bundleId: string,
 *   versionString: string,
 *   buildNumber: string,
 *   log?: (line: string) => void,
 *   sleep?: (milliseconds: number) => Promise<unknown>,
 *   pollAttempts?: number,
 *   pollIntervalMilliseconds?: number,
 * }} options
 * @returns {Promise<ReleaseReport>}
 */
export async function submitAppStoreRelease({
  request,
  bundleId,
  versionString,
  buildNumber,
  log = noLog,
  sleep = delay,
  pollAttempts = 12,
  pollIntervalMilliseconds = 10_000,
}) {
  const appId = await findAppId(request, bundleId);
  const buildId = await findValidBuildId(request, appId, versionString, buildNumber);

  const version = await readVersion(request, appId, versionString);
  if (!version) {
    throw new Error(
      `There is no App Store version ${versionString}. The prepare stage creates it; re-run the ` +
        'Submit (TestFlight) job, or dispatch build-ios.yml with submit=appstore.'
    );
  }
  if (classifyExistingVersion(version, versionString, buildId) === 'done') {
    log(`Version ${versionString} is already ${version.state} with build ${buildNumber}; nothing to submit.`);
    return alreadyDoneReport(versionString, buildNumber, version.state);
  }

  const changes = await enforceFullRelease(request, version, buildId);
  for (const change of changes) log(`Re-applied between the stages: ${change}.`);

  // The read-back proves a write stuck. With nothing written, the version read
  // above already shows the settings.
  const verified = changes.length > 0 ? await verifyFullRelease(request, appId, versionString, buildId) : version;
  const localizations = await describeLocalizations(request, verified.id);
  const problems = readinessProblems(verified.reviewDetail, localizations);
  if (problems.length > 0) {
    throw new Error(
      `Not submitting version ${versionString} for review:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n` +
        'The version is prepared. Fix these in App Store Connect, then re-run the Submit (App Review) job, ' +
        'or press Add for Review there.'
    );
  }

  const submissionId = await findOrCreateReviewSubmission(request, appId);
  await ensureSubmissionItem(request, submissionId, verified.id);
  const submitted = await callApi(
    request,
    'PATCH',
    `/reviewSubmissions/${submissionId}`,
    { data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } } },
    'submit the version for review'
  );

  let state = submitted.data?.attributes?.state;
  for (let attempt = 0; !SUBMITTED_REVIEW_SUBMISSION_STATES.has(state) && attempt < pollAttempts; attempt += 1) {
    await sleep(pollIntervalMilliseconds);
    const current = await callApi(
      request,
      'GET',
      `/reviewSubmissions/${submissionId}`,
      undefined,
      'read the review submission'
    );
    state = current.data?.attributes?.state;
  }
  if (!SUBMITTED_REVIEW_SUBMISSION_STATES.has(state)) {
    throw new Error(
      `The review submission was sent but still reads ${state ?? 'unknown'}, not WAITING_FOR_REVIEW. ` +
        'Check the version in App Store Connect before re-running.'
    );
  }

  /** @type {ReleaseReport} */
  const report = {
    versionString,
    buildNumber,
    state,
    alreadyDone: false,
    changes,
    reviewDetail: verified.reviewDetail,
    localizations,
    problems: [],
  };
  for (const line of formatReport(report)) log(line);
  log(`Submitted for App Review (${state}). It goes live to every user as soon as Apple approves it.`);
  return report;
}

/**
 * Read-only preflight: reports what the two stages would find, and writes
 * nothing. Run through .github/workflows/app-store-check.yml before a release
 * day, so an API problem (a revoked key, a refused `include`, an endpoint Apple
 * retired) surfaces then, not halfway through a release.
 *
 * It inspects `versionString` when that version exists, and otherwise the most
 * recently created iOS version, which is normally the live one, and says so when
 * a named version was not found. Its review notes and screenshots are what a new
 * version would start from, if Apple carries them over. It also names any other
 * unreleased version (a draft, or one in review or waiting to release), because
 * stage 1 refuses to create a version next to one.
 *
 * Besides the version reads, it makes the two reads the stages start with that
 * nothing else exercises: the build query with its preReleaseVersion filters,
 * and the open review submissions stage 2 submits through.
 *
 * What it cannot prove is write access: the reads succeed on any role. The
 * App Manager role was checked by eye in Users and Access instead.
 *
 * @param {{
 *   request: AppStoreConnectRequest,
 *   bundleId: string,
 *   versionString?: string,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{
 *   versionString: string | null,
 *   state: string | null,
 *   releaseType: string | null,
 *   phasedReleaseState: string | null,
 *   reviewDetail: ReviewDetailSummary | null,
 *   localizations: LocalizationSummary[],
 *   problems: string[],
 *   unreleased: string[],
 * }>}
 */
export async function checkAppStoreRelease({ request, bundleId, versionString, log = noLog }) {
  const appId = await findAppId(request, bundleId);
  log(`App found for ${bundleId}.`);

  // The newest is found by sorting below, which only works if it is on the
  // page at all (see versionsListPath).
  const response = await callApi(request, 'GET', versionsListPath(appId), undefined, 'list the App Store versions');
  const included = response.included ?? [];
  const versions = (response.data ?? []).map((resource) => parseVersionResource(resource, included));
  const unreleased = versions.filter((version) => UNRELEASED_VERSION_STATES.has(version.state));

  // ISO 8601 timestamps sort correctly as strings, newest last.
  const newestFirst = [...versions].sort((first, second) => second.createdDate.localeCompare(first.createdDate));
  // An empty string (an unset workflow input) means "the newest", like undefined.
  const named = versionString ? versions.find((version) => version.versionString === versionString) : undefined;
  const inspected = named ?? newestFirst[0];

  if (!inspected) {
    log('No iOS App Store version exists yet.');
    return {
      versionString: null,
      state: null,
      releaseType: null,
      phasedReleaseState: null,
      reviewDetail: null,
      localizations: [],
      problems: ['No iOS App Store version exists yet.'],
      unreleased: [],
    };
  }

  if (versionString && !named) {
    log(
      `Version ${versionString} does not exist yet, so the newest version, ${inspected.versionString}, ` +
        'is inspected instead: it is what a new version starts from.'
    );
  }

  const localizations = await describeLocalizations(request, inspected.id);
  const problems = readinessProblems(inspected.reviewDetail, localizations);
  const builds = await callApi(
    request,
    'GET',
    buildsPath(appId, versionString || inspected.versionString),
    undefined,
    'list builds'
  );
  const openSubmissions = await callApi(
    request,
    'GET',
    openReviewSubmissionsPath(appId),
    undefined,
    'list open review submissions'
  );

  log(`Inspected version ${inspected.versionString}: ${inspected.state}, releaseType ${inspected.releaseType ?? 'unset'}.`);
  log(`- Phased release: ${inspected.phasedRelease ? inspected.phasedRelease.state : 'none'}.`);
  log(describeReviewDetailLine(inspected.reviewDetail));
  for (const localization of localizations) log(describeLocalizationLine(localization));
  log(
    `- Builds listed for ${versionString || inspected.versionString}: ${(builds.data ?? []).length}; ` +
      `open review submissions: ${(openSubmissions.data ?? []).length}.`
  );
  const otherUnreleased = unreleased.filter((version) => version.versionString !== versionString);
  if (otherUnreleased.length > 0) {
    const listed = otherUnreleased.map((version) => `${version.versionString} (${version.state})`).join(', ');
    log(`- Unreleased version(s): ${listed}. Stage 1 refuses to create a version next to one.`);
  }
  for (const problem of problems) log(`Would block a submission: ${problem}`);
  log('Read-only: nothing was changed.');

  return {
    versionString: inspected.versionString,
    state: inspected.state,
    releaseType: inspected.releaseType ?? null,
    phasedReleaseState: inspected.phasedRelease?.state ?? null,
    reviewDetail: inspected.reviewDetail,
    localizations,
    problems,
    unreleased: unreleased.map((version) => version.versionString),
  };
}

/** Arguments each mode needs, beyond the key, key id, issuer id, and bundle id. */
const MODE_ARGUMENTS = {
  prepare: ['version', 'build-number'],
  submit: ['version', 'build-number'],
  check: [],
};

/**
 * Flag/value pairs, strictly, like scripts/checkAppStoreBuild.mjs: a bare flag
 * would silently swallow the next flag as its value.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArguments(argv) {
  /** @type {Record<string, string>} */
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`Malformed argument near "${flag}".`);
    }
    parsed[flag.slice(2)] = value;
  }
  if (!Object.hasOwn(MODE_ARGUMENTS, parsed.mode ?? '')) {
    throw new Error(`--mode must be prepare, submit or check, not "${parsed.mode ?? ''}".`);
  }
  for (const required of ['key', 'key-id', 'issuer-id', 'bundle-id', ...MODE_ARGUMENTS[parsed.mode]]) {
    if (!parsed[required]) {
      throw new Error(`Missing required argument --${required}.`);
    }
  }
  return parsed;
}

/**
 * The real transport behind the injected `request`. Exported for
 * tests/unit/prepareAppStoreRelease.test.ts, which stubs `fetch`.
 *
 * @param {string} privateKeyPem
 * @param {string} keyId
 * @param {string} issuerId
 * @returns {AppStoreConnectRequest}
 */
export function createRequest(privateKeyPem, keyId, issuerId) {
  return async (method, apiPath, body) => {
    // A fresh token per call: each lives 10 minutes, and the submit stage polls.
    const token = createAppStoreConnectToken(privateKeyPem, keyId, issuerId);
    const response = await fetch(`${ASC_API_BASE}${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsedBody = {};
    if (text) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        parsedBody = { raw: text.slice(0, 500) };
      }
    }
    return { ok: response.ok, status: response.status, body: parsedBody };
  };
}

/**
 * @param {string} directory
 * @returns {(locale: string) => string | undefined}
 */
export function readWhatsNewFrom(directory) {
  return (locale) => {
    const notesPath = path.join(directory, `whatsnew-${locale}`);
    return existsSync(notesPath) ? readFileSync(notesPath, 'utf8') : undefined;
  };
}

/**
 * The job summary is where a human reads the stage-1 report before the second
 * approval, so it gets the same lines as the log, success or not. A no-op
 * outside Actions, where there is no summary file.
 *
 * @param {string | undefined} summaryPath
 * @param {string} mode
 * @param {string[]} lines
 */
export function appendStepSummary(summaryPath, mode, lines) {
  if (!summaryPath || lines.length === 0) return;
  appendFileSync(summaryPath, `### App Store version (${mode})\n\n${lines.join('\n')}\n\n`);
}

/**
 * The command line the workflows run. Its collaborators are parameters so that
 * tests/unit/prepareAppStoreRelease.test.ts can drive the mode dispatch and the
 * job summary written on failure without a network.
 *
 * @param {string[]} argv
 * @param {{
 *   makeRequest?: typeof createRequest,
 *   summaryPath?: string,
 *   write?: (text: string) => void,
 * }} [dependencies]
 */
export async function main(
  argv,
  {
    makeRequest = createRequest,
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    write = (text) => process.stdout.write(text),
  } = {}
) {
  const options = parseArguments(argv);
  const request = makeRequest(readFileSync(options.key, 'utf8'), options['key-id'], options['issuer-id']);
  const lines = [];
  const log = (line) => {
    lines.push(line);
    write(`${line}\n`);
  };
  const shared = {
    request,
    bundleId: options['bundle-id'],
    versionString: options.version,
    buildNumber: options['build-number'],
    log,
  };

  try {
    if (options.mode === 'prepare') {
      await prepareAppStoreRelease({
        ...shared,
        readWhatsNew: readWhatsNewFrom(options['whatsnew-dir'] ?? 'store/whatsnew'),
      });
    } else if (options.mode === 'submit') {
      await submitAppStoreRelease(shared);
    } else {
      await checkAppStoreRelease({ request, bundleId: options['bundle-id'], versionString: options.version, log });
    }
  } finally {
    appendStepSummary(summaryPath, options.mode, lines);
  }
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
