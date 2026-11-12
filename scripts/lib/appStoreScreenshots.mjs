/**
 * App Store listing screenshots through the App Asset Library.
 *
 * Apple deprecated `appScreenshotSets` / `appScreenshots` in App Store Connect
 * API 4.5.x (October 2026). The replacement splits a screenshot in two:
 *
 *   - an IMAGE in the app's asset library, uploaded once and shared by every
 *     version that shows it (reserve, PUT the parts, commit, wait for processing);
 *   - a PLACEMENT, which puts one image on one version localization in one
 *     placement group (the device family), at a position set by an ordering
 *     request.
 *
 * So "replace the screenshots" is: get the frames into the library, then make
 * the localization's placements for the group be exactly those images, in
 * listing order. An image a placement shows, or showed, is never deleted here:
 * the live version's placements point at the same images as the version being
 * prepared. The one thing removed from the library is a reservation of our own
 * that a dead run left unusable (see ABANDONED_IMAGE_STATES).
 *
 * Idempotency without a checksum. The library has no checksum attribute (the
 * old flow's `sourceFileChecksum` is gone; Apple validates an upload against
 * the declared `fileSize` instead). So every image this module uploads carries
 * a SHA-256 prefix at the end of its `referenceName`, and a placement counts as
 * showing a frame when its image carries that frame's hash. A frame uploaded by
 * hand in Media Manager has no such name, so it is recognised by its exact byte
 * length instead: the committed frames all differ in size.
 *
 * The placement group is never hard-coded. Apple publishes the catalogue as
 * reference data and says to read it: the frame's pixel size selects an image
 * specification, and the specification selects the group.
 *
 * Nothing here imports scripts/prepareAppStoreRelease.mjs, which is this
 * module's caller. Every call goes through the injected `request`, and the part
 * uploads through an injected `uploadPart`, so tests/unit/appStoreScreenshots.test.ts
 * drives the whole flow with no network.
 */
import { setTimeout as delay } from 'node:timers/promises';

/** Shared with scripts/prepareAppStoreRelease.mjs, whose transport prefixes every path with it. */
export const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1';

export const SCREENSHOT_PLACEMENT_TYPE = 'APP_SCREENSHOT';
const SCREENSHOT_CATEGORY = 'APP_SCREENSHOTS_AND_PREVIEWS';
const APP_STORE_VERSIONS_FEATURE = 'APP_STORE_VERSIONS';

/** How much of a frame's SHA-256 its reference name carries. 64 bits: ample for seven frames. */
const REFERENCE_HASH_LENGTH = 16;

/** Apple's documented cap for a version's screenshot group, used only if the reference data names none. */
const DEFAULT_GROUP_LIMIT = 10;

/** A listing spans a handful of pages at most; this stops a `next` link that never ends. */
const MAXIMUM_PAGES = 20;

/** Image states that mean Apple is still working: reserved, or uploaded and processing. */
const PROCESSING_IMAGE_STATES = new Set(['AWAITING_UPLOAD', 'UPLOAD_COMPLETE']);

/** Image states that cannot back a new placement. */
const UNUSABLE_IMAGE_STATES = new Set(['AWAITING_UPLOAD', 'FAILED', 'REJECTED', 'ARCHIVED']);

/**
 * States of a reservation a dead run left behind: never uploaded, or failed in
 * processing. Only these are ever deleted, and only when they carry our hash.
 */
const ABANDONED_IMAGE_STATES = new Set(['AWAITING_UPLOAD', 'FAILED']);

/**
 * @typedef {{ ok: boolean, status: number, body: any }} AppStoreConnectResponse
 * @typedef {(method: string, apiPath: string, body?: unknown) => Promise<AppStoreConnectResponse>} AppStoreConnectRequest
 * @typedef {(response: AppStoreConnectResponse, purpose: string) => string} DescribeFailure
 * @typedef {{
 *   method?: string,
 *   url: string,
 *   offset: number,
 *   length: number,
 *   requestHeaders?: { name: string, value: string }[],
 * }} UploadOperation
 * @typedef {(operation: UploadOperation, bytes: Uint8Array) => Promise<{ ok: boolean, status: number }>} UploadPart
 * @typedef {{ name: string, fileName: string, bytes: Uint8Array, byteLength: number, sha256: string, width: number, height: number }} ScreenshotFrame
 * @typedef {{
 *   id: string,
 *   referenceName: string | null,
 *   fileSize: number | null,
 *   fileName: string | null,
 *   state: string | null,
 * }} LibraryImage
 * @typedef {{ id: string, group: string | null, state: string | null, image: LibraryImage | null }} ScreenshotPlacement
 * @typedef {'hash' | 'size'} MatchEvidence
 * @typedef {{
 *   frame: ScreenshotFrame,
 *   placement: ScreenshotPlacement | null,
 *   evidence: MatchEvidence | null,
 *   reuseImage: LibraryImage | null,
 * }} ScreenshotSlot
 * @typedef {{
 *   inSync: boolean,
 *   evidence: MatchEvidence | 'mixed' | null,
 *   slots: ScreenshotSlot[],
 *   stale: ScreenshotPlacement[],
 *   abandoned: LibraryImage[],
 * }} ScreenshotPlan
 * @typedef {{ libraryId: string, group: string, maxCount: number }} ScreenshotTarget
 * @typedef {{
 *   changed: boolean,
 *   evidence: MatchEvidence | 'mixed' | null,
 *   uploaded: number,
 *   reused: number,
 *   placed: number,
 *   removed: number,
 * }} ScreenshotSyncResult
 */

const noLog = () => {};

/**
 * Apple's error list as one line. Shared with scripts/prepareAppStoreRelease.mjs,
 * so the two describe a refusal the same way.
 *
 * @param {any} body
 * @returns {string}
 */
export function describeApiErrors(body) {
  if (!Array.isArray(body?.errors)) return JSON.stringify(body);
  return body.errors.map((error) => `${error.title}: ${error.detail ?? ''}`.trim()).join('; ');
}

/** @type {DescribeFailure} */
function describeFailureGenerically(response, purpose) {
  return `Could not ${purpose} (${response.status}): ${describeApiErrors(response.body)}`;
}

/**
 * @param {AppStoreConnectRequest} request
 * @param {DescribeFailure} [describeFailure]
 */
function apiCaller(request, describeFailure = describeFailureGenerically) {
  return async (method, apiPath, body, purpose) => {
    const response = await request(method, apiPath, body);
    if (!response.ok) {
      throw new Error(describeFailure(response, purpose));
    }
    return response.body ?? {};
  };
}

/**
 * Follows `links.next`, which Apple returns as an absolute URL. No `limit` is
 * sent with these reads on purpose: the reference-data endpoint answers a
 * `limit` with a 400, and the placement and library endpoints do not document
 * a maximum, so the default page size plus the next link is the safe shape.
 *
 * A list that cannot be read to its end throws. Every caller treats the result
 * as the whole list: placements cut short can read as in sync when the listing
 * holds more, and library images cut short get uploaded again. So a next link
 * outside the API base (never followed, the token goes with every request) and
 * a list still going after MAXIMUM_PAGES are both errors, not a quiet stop.
 */
async function listAll(callApi, apiPath, purpose) {
  const data = [];
  const included = [];
  let nextPath = apiPath;
  for (let page = 0; nextPath; page += 1) {
    if (page >= MAXIMUM_PAGES) {
      throw new Error(
        `Could not ${purpose}: App Store Connect still had more after ${MAXIMUM_PAGES} pages, so the list would ` +
          'be incomplete.'
      );
    }
    const body = await callApi('GET', nextPath, undefined, purpose);
    data.push(...(body.data ?? []));
    included.push(...(body.included ?? []));
    const nextLink = body.links?.next;
    if (nextLink === undefined || nextLink === null || nextLink === '') {
      nextPath = null;
    } else if (typeof nextLink === 'string' && nextLink.startsWith(ASC_API_BASE)) {
      nextPath = nextLink.slice(ASC_API_BASE.length);
    } else {
      throw new Error(
        `Could not ${purpose}: App Store Connect returned a next-page link outside ${ASC_API_BASE}, which is ` +
          'not followed, so the list would be incomplete.'
      );
    }
  }
  return { data, included };
}

/** @param {{ sha256: string }} frame */
function frameHash(frame) {
  return frame.sha256.slice(0, REFERENCE_HASH_LENGTH);
}

/**
 * The reference name an uploaded frame gets: the shot name for a person reading
 * the asset library, then the hash this module matches on.
 *
 * @param {{ name: string, sha256: string }} frame
 * @returns {string}
 */
export function referenceNameFor(frame) {
  return `${frame.name} ${frameHash(frame)}`;
}

/**
 * The hash a reference name carries, or null for a name this module did not
 * write (an image uploaded in Media Manager, or by another tool).
 *
 * @param {string | null | undefined} referenceName
 * @returns {string | null}
 */
export function referenceHash(referenceName) {
  if (typeof referenceName !== 'string') return null;
  const match = new RegExp(`(?:^|\\s)([0-9a-f]{${REFERENCE_HASH_LENGTH}})$`).exec(referenceName);
  return match ? match[1] : null;
}

/**
 * Whether an image is this frame, and how we know.
 *
 * A name carrying a DIFFERENT hash is a different frame of ours, so it never
 * falls through to the size comparison: two captures of one screen can be the
 * same length by accident, and the hash is the stronger statement.
 *
 * Verified against the live listing on 2026-11-12: for seven frames uploaded in
 * Media Manager, Apple's `fileSize` was the original file's exact byte length
 * (and the deprecated `sourceFileChecksum` its MD5), and their reference names
 * were the file names, with " (n)" appended to a repeated one.
 *
 * @param {ScreenshotFrame} frame
 * @param {LibraryImage | null} image
 * @returns {MatchEvidence | null}
 */
export function matchEvidence(frame, image) {
  if (!image) return null;
  const hash = referenceHash(image.referenceName);
  if (hash) return hash === frameHash(frame) ? 'hash' : null;
  return typeof image.fileSize === 'number' && image.fileSize === frame.byteLength ? 'size' : null;
}

function fitsDimensions(dimensions, width, height) {
  return (
    dimensions &&
    dimensions.minWidth <= width &&
    width <= dimensions.maxWidth &&
    dimensions.minHeight <= height &&
    height <= dimensions.maxHeight
  );
}

/**
 * Resolves the placement group for screenshots of one pixel size from Apple's
 * reference data: the image specifications that accept the size, then the
 * groups whose specification mapping lists one of them, restricted to the
 * groups an App Store version takes.
 *
 * Throws unless exactly one group matches. Guessing between two would put the
 * frames on the wrong device family, and none means Apple no longer accepts
 * the size the capture produces.
 *
 * @param {any} referenceData the body of GET /v1/appAssetLibraryRefData
 * @param {number} width
 * @param {number} height
 * @returns {{ group: string, maxCount: number }}
 */
export function resolveScreenshotGroup(referenceData, width, height) {
  const resource = Array.isArray(referenceData?.data) ? referenceData.data[0] : referenceData?.data;
  const attributes = resource?.attributes;
  if (!attributes) {
    throw new Error('App Store Connect returned no asset library reference data.');
  }

  const specificationIds = new Set(
    (attributes.imageSpecs ?? [])
      .filter(
        (specification) =>
          (specification.compatiblePlacementTypes ?? []).includes(SCREENSHOT_PLACEMENT_TYPE) &&
          fitsDimensions(specification.dimensions, width, height)
      )
      .map((specification) => specification.specId)
  );
  if (specificationIds.size === 0) {
    throw new Error(
      `Apple's reference data lists no screenshot specification for ${width}x${height}. The listing frames are ` +
        'captured at a size App Store Connect no longer accepts: check the accepted sizes and re-capture.'
    );
  }

  const policy = (attributes.features ?? [])
    .find((feature) => feature.featureId === APP_STORE_VERSIONS_FEATURE)
    ?.placementPolicies?.find((candidate) => candidate.placementType === SCREENSHOT_PLACEMENT_TYPE);
  const versionGroups = policy ? new Set((policy.groupLimits ?? []).flatMap((limit) => limit.groupIds ?? [])) : null;

  const placementType = (attributes.placementTypes ?? []).find(
    (candidate) => candidate.placementTypeId === SCREENSHOT_PLACEMENT_TYPE
  );
  const groups = [
    ...new Set(
      (placementType?.specMappings ?? [])
        .filter((mapping) => (mapping.specs ?? []).some((specificationId) => specificationIds.has(specificationId)))
        .map((mapping) => mapping.placementGroupId)
        .filter((group) => !versionGroups || versionGroups.has(group))
    ),
  ];
  if (groups.length !== 1) {
    throw new Error(
      `Apple's reference data maps ${width}x${height} screenshots to ` +
        `${groups.length === 0 ? 'no placement group' : `more than one placement group (${groups.join(', ')})`}, ` +
        'so the group cannot be chosen safely.'
    );
  }

  const group = groups[0];
  const maxCount =
    (policy?.groupLimits ?? []).find((limit) => (limit.groupIds ?? []).includes(group))?.maxCount ?? DEFAULT_GROUP_LIMIT;
  return { group, maxCount };
}

/**
 * The app's asset library and the placement group the frames belong in.
 *
 * @param {{
 *   request: AppStoreConnectRequest,
 *   describeFailure?: DescribeFailure,
 *   appId: string,
 *   frames: ScreenshotFrame[],
 * }} options
 * @returns {Promise<ScreenshotTarget>}
 */
export async function readScreenshotTarget({ request, describeFailure, appId, frames }) {
  const callApi = apiCaller(request, describeFailure);
  const library = await callApi('GET', `/apps/${appId}/assetLibrary`, undefined, "read the app's asset library");
  const libraryId = library.data?.id ?? library.id;
  if (!libraryId) {
    throw new Error('App Store Connect returned no asset library for the app.');
  }
  const referenceData = await callApi(
    'GET',
    `/appAssetLibraryRefData?filter[features]=${APP_STORE_VERSIONS_FEATURE}`,
    undefined,
    'read the asset library reference data'
  );
  return { libraryId, ...resolveScreenshotGroup(referenceData, frames[0].width, frames[0].height) };
}

function parseImage(imageId, resource) {
  return {
    id: imageId,
    referenceName: resource?.attributes?.referenceName ?? null,
    fileSize: resource?.attributes?.fileSize ?? null,
    fileName: resource?.attributes?.fileName ?? null,
    state: resource?.attributes?.state ?? null,
  };
}

/**
 * One localization's screenshot placements in display order, each with the
 * image it shows. With `group` the read is the one Apple documents for a
 * device family; without it every screenshot group comes back, which the check
 * mode uses to see what else is on the listing.
 *
 * @param {{
 *   request: AppStoreConnectRequest,
 *   describeFailure?: DescribeFailure,
 *   localizationId: string,
 *   group?: string,
 * }} options
 * @returns {Promise<ScreenshotPlacement[]>}
 */
export async function readScreenshotPlacements({ request, describeFailure, localizationId, group }) {
  const callApi = apiCaller(request, describeFailure);
  const groupFilter = group ? `&filter[placementGroup]=${encodeURIComponent(group)}` : '';
  const { data, included } = await listAll(
    callApi,
    `/appStoreVersionLocalizations/${localizationId}/placements?filter[placementType]=${SCREENSHOT_PLACEMENT_TYPE}` +
      `${groupFilter}&sort=placementGroupPosition&include=image` +
      '&fields[appAssetLibraryImages]=referenceName,state,fileName,fileSize',
    'list the screenshot placements'
  );
  const images = new Map(
    included.filter((item) => item.type === 'appAssetLibraryImages').map((item) => [item.id, item])
  );
  return data.map((placement) => {
    const imageId = placement.relationships?.image?.data?.id ?? null;
    return {
      id: placement.id,
      group: placement.attributes?.placementGroup ?? null,
      state: placement.attributes?.state ?? null,
      image: imageId ? parseImage(imageId, images.get(imageId)) : null,
    };
  });
}

/**
 * Every image in the app's asset library, so a frame already uploaded (by an
 * earlier release, or by a run that died before placing it) is reused.
 *
 * @param {{ request: AppStoreConnectRequest, describeFailure?: DescribeFailure, libraryId: string }} options
 * @returns {Promise<LibraryImage[]>}
 */
export async function readLibraryImages({ request, describeFailure, libraryId }) {
  const callApi = apiCaller(request, describeFailure);
  const { data } = await listAll(callApi, `/appAssetLibraries/${libraryId}/images`, 'list the asset library images');
  return data.map((image) => parseImage(image.id, image));
}

/**
 * The deprecated screenshot sets, read only so the check mode can put Apple's
 * own MD5 (`sourceFileChecksum`) beside the placements. That is the one place
 * App Store Connect states what bytes it holds, which settles whether a
 * size-only match on a hand-uploaded frame is telling the truth.
 *
 * @param {{ request: AppStoreConnectRequest, describeFailure?: DescribeFailure, localizationId: string }} options
 * @returns {Promise<{ displayType: string | null, checksums: (string | null)[] }[]>}
 */
export async function readLegacyScreenshotSets({ request, describeFailure, localizationId }) {
  const callApi = apiCaller(request, describeFailure);
  const response = await callApi(
    'GET',
    `/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?include=appScreenshots&limit=50&limit[appScreenshots]=50`,
    undefined,
    'list the screenshot sets'
  );
  const screenshots = new Map(
    (response.included ?? []).filter((item) => item.type === 'appScreenshots').map((item) => [item.id, item])
  );
  return (response.data ?? []).map((screenshotSet) => ({
    displayType: screenshotSet.attributes?.screenshotDisplayType ?? null,
    checksums: (screenshotSet.relationships?.appScreenshots?.data ?? []).map(
      (linkage) => screenshots.get(linkage.id)?.attributes?.sourceFileChecksum ?? null
    ),
  }));
}

/**
 * Works out what a sync has to do, without doing it. Pure.
 *
 * Each frame keeps the first unclaimed placement that already shows it, so a
 * re-run after a partial failure, or a release that re-captured two frames of
 * seven, touches only what differs. What is left over is stale. A frame with no
 * placement reuses a library image carrying its hash when there is a usable
 * one.
 *
 * `inSync` is stricter than "every frame has a placement": the placements have
 * to be exactly the frames, in listing order, because the order is what the
 * store displays.
 *
 * @param {ScreenshotFrame[]} frames in listing order
 * @param {ScreenshotPlacement[]} placements in display order
 * @param {LibraryImage[]} [libraryImages]
 * @returns {ScreenshotPlan}
 */
export function planScreenshotSync(frames, placements, libraryImages = []) {
  const claimed = new Set();
  /** @type {ScreenshotSlot[]} */
  const slots = frames.map((frame) => {
    const placement =
      placements.find((candidate) => !claimed.has(candidate.id) && matchEvidence(frame, candidate.image) !== null) ??
      null;
    if (placement) claimed.add(placement.id);
    return {
      frame,
      placement,
      evidence: placement ? matchEvidence(frame, placement.image) : null,
      reuseImage: null,
    };
  });

  /** @type {LibraryImage[]} */
  const abandoned = [];
  for (const slot of slots) {
    if (slot.placement) continue;
    const ours = libraryImages.filter((image) => referenceHash(image.referenceName) === frameHash(slot.frame));
    slot.reuseImage = ours.find((image) => !UNUSABLE_IMAGE_STATES.has(image.state ?? '')) ?? null;
    if (!slot.reuseImage) {
      abandoned.push(...ours.filter((image) => ABANDONED_IMAGE_STATES.has(image.state ?? '')));
    }
  }

  const inSync =
    placements.length === frames.length &&
    frames.every((frame, index) => matchEvidence(frame, placements[index].image) !== null);
  const evidences = new Set(slots.map((slot) => slot.evidence).filter((evidence) => evidence !== null));
  /** @type {MatchEvidence | 'mixed' | null} */
  let evidence = null;
  if (inSync) {
    evidence = evidences.size === 1 ? /** @type {MatchEvidence} */ ([...evidences][0]) : 'mixed';
  }

  return {
    inSync,
    evidence,
    slots,
    stale: placements.filter((placement) => !claimed.has(placement.id)),
    abandoned,
  };
}

/** How an in-sync plan says it knows, by the evidence its slots matched on. */
const EVIDENCE_DESCRIPTIONS = {
  hash: 'matched by content hash',
  size: 'matched by file size, so uploaded by hand',
  mixed: 'matched by content hash and by file size',
};

/**
 * One line saying what a plan found, for a report a person reads before
 * approving a submission.
 *
 * @param {ScreenshotPlan} plan
 * @param {number} placementCount
 * @returns {string}
 */
export function describeScreenshotPlan(plan, placementCount) {
  if (plan.inSync) {
    const how = EVIDENCE_DESCRIPTIONS[plan.evidence ?? 'mixed'];
    return `${placementCount} screenshot(s), in sync with the committed frames (${how})`;
  }
  const missing = plan.slots.filter((slot) => !slot.placement).map((slot) => slot.frame.fileName);
  if (missing.length === 0 && plan.stale.length === 0) {
    return `${placementCount} screenshot(s), the committed frames in a DIFFERENT ORDER`;
  }
  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} committed frame(s) not on the listing (${missing.join(', ')})`);
  if (plan.stale.length > 0) parts.push(`${plan.stale.length} screenshot(s) on the listing that are not committed frames`);
  return `${placementCount} screenshot(s), DIFFERS from the committed frames: ${parts.join('; ')}`;
}

/**
 * The real part upload. Apple's upload URLs are unauthenticated and
 * time-limited, so no token is sent, and the URL is never logged.
 *
 * @type {UploadPart}
 */
export async function uploadPartWithFetch(operation, bytes) {
  const headers = Object.fromEntries((operation.requestHeaders ?? []).map((header) => [header.name, header.value]));
  const response = await fetch(operation.url, { method: operation.method ?? 'PUT', headers, body: bytes });
  return { ok: response.ok, status: response.status };
}

async function uploadFrame(callApi, uploadPart, libraryId, frame) {
  const reserved = await callApi(
    'POST',
    '/appAssetLibraryImages',
    {
      data: {
        type: 'appAssetLibraryImages',
        attributes: {
          fileName: frame.fileName,
          fileSize: frame.byteLength,
          category: SCREENSHOT_CATEGORY,
          referenceName: referenceNameFor(frame),
        },
        relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: libraryId } } },
      },
    },
    `reserve ${frame.fileName} in the asset library`
  );
  const imageId = reserved.data?.id;
  const operations = reserved.data?.attributes?.uploadOperations ?? [];
  if (!imageId || operations.length === 0) {
    throw new Error(`App Store Connect reserved ${frame.fileName} without an id or upload operations.`);
  }

  for (const operation of operations) {
    const part = frame.bytes.subarray(operation.offset, operation.offset + operation.length);
    const result = await uploadPart(operation, part);
    if (!result.ok) {
      throw new Error(
        `Uploading ${frame.fileName} to Apple's storage failed (${result.status}). The reservation is left in the ` +
          'asset library and the next run removes it.'
      );
    }
  }

  // `uploaded` alone: the asset library has no checksum to send. Apple checks
  // the bytes it received against the fileSize declared in the reservation.
  await callApi(
    'PATCH',
    `/appAssetLibraryImages/${imageId}`,
    { data: { type: 'appAssetLibraryImages', id: imageId, attributes: { uploaded: true } } },
    `commit the upload of ${frame.fileName}`
  );
  return imageId;
}

async function waitForImages(callApi, imageIds, { sleep, pollAttempts, pollIntervalMilliseconds }) {
  let waiting = [...imageIds];
  for (let attempt = 0; waiting.length > 0; attempt += 1) {
    const stillWaiting = [];
    for (const imageId of waiting) {
      const image = await callApi('GET', `/appAssetLibraryImages/${imageId}`, undefined, 'read an uploaded image');
      const state = image.data?.attributes?.state;
      if (PROCESSING_IMAGE_STATES.has(state)) {
        stillWaiting.push(imageId);
        continue;
      }
      // Processing is over. Every state that cannot back a placement stops the
      // run HERE, not only FAILED: step 2 deletes a stale placement to make room
      // when the group is at its cap, and a create that Apple then refuses would
      // leave the listing a screenshot short.
      if (UNUSABLE_IMAGE_STATES.has(state)) {
        const fileName = image.data?.attributes?.fileName ?? imageId;
        const details = JSON.stringify(image.data?.attributes?.stateDetails ?? null);
        throw new Error(
          state === 'FAILED'
            ? `Apple could not process an uploaded screenshot (${fileName}): ${details}. Nothing on the listing was changed.`
            : `Apple left an uploaded screenshot (${fileName}) ${state}, which cannot be placed: ${details}. ` +
              'Nothing on the listing was changed.'
        );
      }
    }
    waiting = stillWaiting;
    if (waiting.length === 0) return;
    if (attempt + 1 >= pollAttempts) {
      throw new Error(
        `${waiting.length} uploaded screenshot(s) were still processing after ${pollAttempts} checks. Nothing on ` +
          'the listing was changed; re-run, and the uploads are reused.'
      );
    }
    await sleep(pollIntervalMilliseconds);
  }
}

/**
 * Makes one localization's screenshots be exactly `frames`, in order.
 *
 * The order of work is the safety property:
 *
 *   1. Every missing frame is uploaded and PROCESSED before any placement
 *      changes, so a failed upload leaves the listing exactly as it was.
 *   2. Placements are created before stale ones are deleted, as far as the
 *      group's cap allows, so the group never passes through empty. Stage 2
 *      refuses a localization with no screenshots, and a run that died halfway
 *      must not leave one.
 *   3. One ordering request sets the display order, and the result is read
 *      back: a 200 from each call is not proof the listing shows the frames.
 *
 * Idempotent. A second run finds the placements in sync and writes nothing.
 *
 * @param {{
 *   request: AppStoreConnectRequest,
 *   describeFailure?: DescribeFailure,
 *   uploadPart: UploadPart,
 *   libraryId: string,
 *   localizationId: string,
 *   group: string,
 *   maxCount: number,
 *   frames: ScreenshotFrame[],
 *   log?: (line: string) => void,
 *   sleep?: (milliseconds: number) => Promise<unknown>,
 *   pollAttempts?: number,
 *   pollIntervalMilliseconds?: number,
 *   verifyAttempts?: number,
 * }} options
 * @returns {Promise<ScreenshotSyncResult>}
 */
export async function syncScreenshots({
  request,
  describeFailure,
  uploadPart,
  libraryId,
  localizationId,
  group,
  maxCount,
  frames,
  log = noLog,
  sleep = delay,
  pollAttempts = 60,
  pollIntervalMilliseconds = 5_000,
  verifyAttempts = 4,
}) {
  const callApi = apiCaller(request, describeFailure);
  const readPlacements = () => readScreenshotPlacements({ request, describeFailure, localizationId, group });

  const before = await readPlacements();
  const firstLook = planScreenshotSync(frames, before);
  if (firstLook.inSync) {
    return { changed: false, evidence: firstLook.evidence, uploaded: 0, reused: 0, placed: 0, removed: 0 };
  }
  if (frames.length > maxCount) {
    throw new Error(`${frames.length} frames is over the ${maxCount} screenshots App Store Connect allows in ${group}.`);
  }

  const libraryImages = await readLibraryImages({ request, describeFailure, libraryId });
  const plan = planScreenshotSync(frames, before, libraryImages);

  // A reservation a dead run left behind would otherwise sit in the library for
  // good. Best effort: a refusal here must not stop the upload that replaces it.
  for (const image of plan.abandoned) {
    const removal = await request('DELETE', `/appAssetLibraryImages/${image.id}`);
    log(
      removal.ok
        ? `Removed an abandoned upload of ${image.fileName ?? image.id} from the asset library.`
        : `Could not remove an abandoned upload of ${image.fileName ?? image.id} (${removal.status}); leaving it.`
    );
  }

  // 1. Uploads, all of them, before the listing is touched.
  /** @type {Map<string, string>} */
  const imageIdByFrame = new Map();
  const awaitingProcessing = [];
  let uploaded = 0;
  let reused = 0;
  for (const slot of plan.slots) {
    if (slot.placement) continue;
    if (slot.reuseImage) {
      imageIdByFrame.set(slot.frame.name, slot.reuseImage.id);
      if (PROCESSING_IMAGE_STATES.has(slot.reuseImage.state ?? '')) awaitingProcessing.push(slot.reuseImage.id);
      reused += 1;
      continue;
    }
    const imageId = await uploadFrame(callApi, uploadPart, libraryId, slot.frame);
    imageIdByFrame.set(slot.frame.name, imageId);
    awaitingProcessing.push(imageId);
    uploaded += 1;
    log(`Uploaded ${slot.frame.fileName} to the asset library.`);
  }
  await waitForImages(callApi, awaitingProcessing, { sleep, pollAttempts, pollIntervalMilliseconds });

  // 2. Placements: create before delete, inside the cap.
  const staleQueue = [...plan.stale];
  const deletePlacement = (placement) =>
    callApi('DELETE', `/appAssetLibraryPlacements/${placement.id}`, undefined, 'remove a stale screenshot placement');
  const orderedPlacementIds = [];
  let liveCount = before.length;
  let placed = 0;
  let removed = 0;
  for (const slot of plan.slots) {
    if (slot.placement) {
      orderedPlacementIds.push(slot.placement.id);
      continue;
    }
    if (liveCount >= maxCount) {
      const stalePlacement = staleQueue.shift();
      if (!stalePlacement) {
        throw new Error(`${group} is at its cap of ${maxCount} screenshots with nothing stale left to remove.`);
      }
      await deletePlacement(stalePlacement);
      liveCount -= 1;
      removed += 1;
    }
    const created = await callApi(
      'POST',
      '/appAssetLibraryPlacements',
      {
        data: {
          type: 'appAssetLibraryPlacements',
          attributes: { placementType: SCREENSHOT_PLACEMENT_TYPE, placementGroup: group },
          relationships: {
            image: { data: { type: 'appAssetLibraryImages', id: imageIdByFrame.get(slot.frame.name) } },
            appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } },
          },
        },
      },
      `place ${slot.frame.fileName} on the listing`
    );
    if (!created.data?.id) {
      throw new Error(`App Store Connect placed ${slot.frame.fileName} without returning a placement id.`);
    }
    orderedPlacementIds.push(created.data.id);
    liveCount += 1;
    placed += 1;
  }
  for (const stalePlacement of staleQueue) {
    await deletePlacement(stalePlacement);
    removed += 1;
  }

  // 3. The display order is the order of the ids in this one request.
  await callApi(
    'POST',
    '/appAssetLibraryPlacementOrderingRequests',
    {
      data: {
        type: 'appAssetLibraryPlacementOrderingRequests',
        attributes: { placementGroup: group },
        relationships: {
          orderedPlacements: {
            data: orderedPlacementIds.map((placementId) => ({ type: 'appAssetLibraryPlacements', id: placementId })),
          },
          appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } },
        },
      },
    },
    'set the screenshot order'
  );

  // 4. Read back. Apple does not say whether the ordering request applies
  // before it answers, so the read is repeated a few times before it counts as
  // a failure.
  let after = await readPlacements();
  let verified = planScreenshotSync(frames, after);
  for (let attempt = 1; !verified.inSync && attempt < verifyAttempts; attempt += 1) {
    await sleep(pollIntervalMilliseconds);
    after = await readPlacements();
    verified = planScreenshotSync(frames, after);
  }
  if (!verified.inSync) {
    throw new Error(
      'The screenshot placements were written, but reading them back does not show the committed frames in ' +
        `order (${describeScreenshotPlan(verified, after.length)}). Check the version in App Store Connect.`
    );
  }
  return { changed: true, evidence: verified.evidence, uploaded, reused, placed, removed };
}
