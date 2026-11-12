/**
 * Fixtures for the store-listing upload tests: generated PNG frames, and an
 * in-memory App Asset Library.
 *
 * The library fake is STATEFUL on purpose, for the same reason as the fake App
 * Store Connect in tests/unit/prepareAppStoreRelease.test.ts. The sync ends by
 * reading the placements back and failing if they are not the frames in order,
 * so a fake that only recorded calls would let a skipped write pass. Here a
 * skipped placement, a wrong order or an unprocessed image is still wrong when
 * it is read back, which is what would happen against Apple.
 *
 * It also enforces the rules Apple documents and the sync relies on: a commit
 * fails when the bytes received are not the declared fileSize, an image cannot
 * be placed while it is processing, a group cannot go over its cap, and an
 * image that is still placed cannot be deleted.
 *
 * Shapes follow Apple's documented examples for /v1/appAssetLibraryRefData,
 * /v1/appAssetLibraryImages and /v1/appAssetLibraryPlacements (read 2026-11-12).
 */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const FRAME_WIDTH = 1320;
export const FRAME_HEIGHT = 2868;
export const SCREENSHOT_GROUP = 'IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE';
export const LIBRARY_ID = 'library-1';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'ascii');
  // The CRC is not checked by anything under test, so four zero bytes stand in.
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

/**
 * A structurally valid PNG header with a payload of a chosen length. Not a
 * decodable image: the code under test reads IHDR and the chunk list, and
 * hashes the bytes, and never decodes pixels.
 */
export function makePng({
  width = FRAME_WIDTH,
  height = FRAME_HEIGHT,
  colourType = 2,
  payloadBytes = 32,
  fill = 0,
  transparencyChunk = false,
}: {
  width?: number;
  height?: number;
  colourType?: number;
  payloadBytes?: number;
  fill?: number;
  transparencyChunk?: boolean;
} = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(colourType, 9);
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', header),
    ...(transparencyChunk ? [chunk('tRNS', Buffer.alloc(2))] : []),
    chunk('IDAT', Buffer.alloc(payloadBytes, fill)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface TestFrame {
  name: string;
  fileName: string;
  bytes: Uint8Array;
  byteLength: number;
  sha256: string;
  sha1: string;
  md5: string;
  width: number;
  height: number;
}

const digest = (algorithm: string, bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex');

/** A frame as scripts/lib/listingFrames.mjs returns it, built from a generated PNG. */
export function makeFrame(
  name: string,
  options: { width?: number; height?: number; payloadBytes?: number; fill?: number } = {}
): TestFrame {
  const bytes = makePng(options);
  return {
    name,
    fileName: `${name}.png`,
    bytes,
    byteLength: bytes.byteLength,
    sha256: digest('sha256', bytes),
    sha1: digest('sha1', bytes),
    md5: digest('md5', bytes),
    width: options.width ?? FRAME_WIDTH,
    height: options.height ?? FRAME_HEIGHT,
  };
}

/**
 * Seven frames with the shot names the listing uses, every one a different
 * length (the size match on hand-uploaded frames depends on that). `generation`
 * changes the bytes, which is what a re-capture does.
 */
export function makeListingFrames(generation = 0): TestFrame[] {
  return [
    '01-agents',
    '02-board',
    '03-session-terminal',
    '04-session-chat',
    '05-session-changes',
    '06-file-diff',
    '07-command-terminal',
  ].map((name, index) => makeFrame(name, { payloadBytes: 40 + index * 3 + generation * 100, fill: generation }));
}

/** The reference name scripts/lib/appStoreScreenshots.mjs gives an uploaded frame. */
export const referenceNameOf = (frame: TestFrame) => `${frame.name} ${frame.sha256.slice(0, 16)}`;

/** The reference data Apple's GET /v1/appAssetLibraryRefData example shows, for one screenshot size. */
export function appleReferenceData({
  width = FRAME_WIDTH,
  height = FRAME_HEIGHT,
  group = SCREENSHOT_GROUP,
  maxCount = 10,
}: { width?: number; height?: number; group?: string; maxCount?: number } = {}) {
  return {
    data: [
      {
        type: 'appAssetLibraryRefData',
        id: '1',
        attributes: {
          features: [
            {
              featureId: 'APP_STORE_VERSIONS',
              placementPolicies: [
                { placementType: 'APP_SCREENSHOT', groupLimits: [{ groupIds: [group, 'MAC_PROFILE'], maxCount }] },
              ],
            },
          ],
          placementProfileGroups: [
            { placementProfileGroupId: group, platform: 'IPHONE_APP_STORE', displayClassId: 'IPHONE_LARGE_DISPLAY' },
            { placementProfileGroupId: 'MAC_PROFILE', platform: 'MAC_APP_STORE', displayClassId: 'MAC_DISPLAY' },
          ],
          imageSpecs: [
            {
              specId: 'spec-iphone',
              dimensions: { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height },
              compatiblePlacementTypes: ['APP_SCREENSHOT', 'IMESSAGE_APP_SCREENSHOT'],
              alphaAllowed: false,
              fileExtensions: ['.jpg', '.jpeg', '.png'],
              mimeTypes: ['image/jpeg', 'image/png'],
            },
            {
              specId: 'spec-mac',
              dimensions: { minWidth: 2880, maxWidth: 2880, minHeight: 1800, maxHeight: 1800 },
              compatiblePlacementTypes: ['APP_SCREENSHOT'],
              alphaAllowed: false,
            },
          ],
          placementTypes: [
            {
              placementTypeId: 'APP_SCREENSHOT',
              acceptsAssetCategories: ['APP_SCREENSHOTS_AND_PREVIEWS'],
              specMappings: [
                { placementGroupId: group, specs: ['spec-iphone'] },
                { placementGroupId: 'MAC_PROFILE', specs: ['spec-mac'] },
              ],
            },
          ],
          displayClasses: [{ displayClassId: 'IPHONE_LARGE_DISPLAY', deviceFamily: 'IPHONE', screenDimensions: ['6.9'] }],
        },
      },
    ],
  };
}

export interface FakeLibraryImage {
  id: string;
  referenceName: string | null;
  fileName: string | null;
  fileSize: number | null;
  state: string;
  receivedBytes: number;
  readsUntilProcessed: number;
}

export interface FakePlacement {
  id: string;
  localizationId: string;
  group: string;
  imageId: string;
}

export interface AssetLibrarySeed {
  images?: (Pick<FakeLibraryImage, 'id'> & Partial<FakeLibraryImage>)[];
  placements?: (Pick<FakePlacement, 'id' | 'localizationId' | 'imageId'> & Partial<FakePlacement>)[];
  maxCount?: number;
  /** How many reads an uploaded image answers UPLOAD_COMPLETE before it is processed. */
  processingReads?: number;
  /** File names whose processing ends FAILED. */
  failProcessing?: string[];
  /** The finished state every uploaded image ends processing in, instead of PREPARE_FOR_SUBMISSION (for example REJECTED). */
  processingEndsAs?: string;
  /**
   * The ordering request answers 201 but only takes effect after this many
   * placement reads that follow it, as Apple may not apply it before answering.
   */
  orderingAppliesAfterReads?: number;
  /** File names whose part upload is refused by storage. */
  failUploadPart?: string[];
  /** The ordering request answers 201 but is not applied. */
  ignoreOrdering?: boolean;
  /** `METHOD path` prefixes answered with the given status. */
  failWith?: { prefix: string; status: number }[];
  referenceData?: unknown;
}

export interface LibraryCall {
  method: string;
  path: string;
  body: unknown;
}

interface UploadOperation {
  method?: string;
  url: string;
  offset: number;
  length: number;
  requestHeaders?: { name: string; value: string }[];
}

interface Linkage {
  data?: { id?: string };
}

interface WriteBody {
  data?: {
    attributes?: Record<string, unknown>;
    relationships?: Record<string, Linkage & { data?: { id?: string } | { id: string }[] }>;
  };
}

const PROCESSING_STATES = ['AWAITING_UPLOAD', 'UPLOAD_COMPLETE'];

/**
 * Placements a version already carries for `frames`, as a seed.
 *
 * `by: 'size'` is a frame uploaded by hand in Media Manager: no hash in its
 * reference name, only the same byte length. `by: 'hash'` is one this code
 * uploaded.
 */
export function placedFrames(
  frames: TestFrame[],
  { localizationId, by, prefix = 'old' }: { localizationId: string; by: 'size' | 'hash'; prefix?: string }
): Required<Pick<AssetLibrarySeed, 'images' | 'placements'>> {
  return {
    images: frames.map((frame, index) => ({
      id: `${prefix}-image-${index}`,
      referenceName: by === 'hash' ? referenceNameOf(frame) : null,
      fileName: frame.fileName,
      fileSize: frame.byteLength,
      state: 'APPROVED',
    })),
    placements: frames.map((_frame, index) => ({
      id: `${prefix}-placement-${localizationId}-${index}`,
      localizationId,
      imageId: `${prefix}-image-${index}`,
    })),
  };
}

export function createFakeAssetLibrary(seed: AssetLibrarySeed = {}) {
  const maxCount = seed.maxCount ?? 10;
  const images = new Map<string, FakeLibraryImage>(
    (seed.images ?? []).map((image) => [
      image.id,
      {
        referenceName: null,
        fileName: null,
        fileSize: null,
        state: 'PREPARE_FOR_SUBMISSION',
        receivedBytes: 0,
        readsUntilProcessed: 0,
        ...image,
      },
    ])
  );
  const placements: FakePlacement[] = (seed.placements ?? []).map((placement) => ({
    group: SCREENSHOT_GROUP,
    ...placement,
  }));
  const calls: LibraryCall[] = [];
  const partUploads: { imageId: string; length: number; headers: Record<string, string> }[] = [];
  /** The fewest placements each localization's group held after any delete. */
  const lowestCount = new Map<string, number>();
  let created = 0;

  const respond = (status: number, body: unknown = {}) => ({ ok: status < 300, status, body });
  const refuse = (status: number, title: string, detail: string) => respond(status, { errors: [{ title, detail }] });

  const imageResource = (image: FakeLibraryImage) => ({
    type: 'appAssetLibraryImages',
    id: image.id,
    attributes: {
      category: 'APP_SCREENSHOTS_AND_PREVIEWS',
      fileName: image.fileName,
      fileSize: image.fileSize,
      referenceName: image.referenceName,
      state: image.state,
      stateDetails: image.state === 'FAILED' ? { errors: [{ code: 'IMAGE_INVALID' }] } : null,
    },
  });

  const countIn = (localizationId: string, group: string) =>
    placements.filter((placement) => placement.localizationId === localizationId && placement.group === group).length;

  let deferredOrdering: { current: FakePlacement[]; orderedIds: string[]; readsLeft: number } | null = null;

  function applyOrdering(current: FakePlacement[], orderedIds: string[]) {
    for (const placement of current) placements.splice(placements.indexOf(placement), 1);
    for (const placementId of orderedIds) {
      placements.push(current.find((placement) => placement.id === placementId) as FakePlacement);
    }
  }

  function route(method: string, apiPath: string, body?: unknown) {
    calls.push({ method, path: apiPath, body });
    const failure = (seed.failWith ?? []).find((candidate) => `${method} ${apiPath}`.startsWith(candidate.prefix));
    if (failure) return refuse(failure.status, 'Injected failure', `status ${failure.status}`);

    const [pathname, query = ''] = apiPath.split('?');
    const params = new URLSearchParams(query);
    const write = body as WriteBody | undefined;
    let match: RegExpMatchArray | null;

    if (method === 'GET' && /^\/apps\/[^/]+\/assetLibrary$/.test(pathname)) {
      return respond(200, { data: { type: 'appAssetLibraries', id: LIBRARY_ID } });
    }
    if (method === 'GET' && pathname === '/appAssetLibraryRefData') {
      // Apple answers a `limit` on this collection with a 400 (a live report,
      // 2026-11-08), which is why the code under test sends none.
      if (params.has('limit')) return refuse(400, 'PARAMETER_ERROR.ILLEGAL', 'limit is not allowed here');
      return respond(200, seed.referenceData ?? appleReferenceData({ maxCount }));
    }
    if ((match = pathname.match(/^\/appStoreVersionLocalizations\/([^/]+)\/placements$/)) && method === 'GET') {
      if (deferredOrdering) {
        if (deferredOrdering.readsLeft > 0) deferredOrdering.readsLeft -= 1;
        else {
          applyOrdering(deferredOrdering.current, deferredOrdering.orderedIds);
          deferredOrdering = null;
        }
      }
      const group = params.get('filter[placementGroup]');
      const selected = placements.filter(
        (placement) => placement.localizationId === match?.[1] && (group === null || placement.group === group)
      );
      return respond(200, {
        data: selected.map((placement) => ({
          type: 'appAssetLibraryPlacements',
          id: placement.id,
          attributes: { placementType: 'APP_SCREENSHOT', placementGroup: placement.group, state: 'ACTIVE' },
          relationships: { image: { data: { type: 'appAssetLibraryImages', id: placement.imageId } } },
        })),
        included: [...new Set(selected.map((placement) => placement.imageId))]
          .map((imageId) => images.get(imageId))
          .filter((image): image is FakeLibraryImage => image !== undefined)
          .map(imageResource),
      });
    }
    if ((match = pathname.match(/^\/appAssetLibraries\/([^/]+)\/images$/)) && method === 'GET') {
      return respond(200, { data: [...images.values()].map(imageResource) });
    }
    if (method === 'POST' && pathname === '/appAssetLibraryImages') {
      const attributes = write?.data?.attributes ?? {};
      created += 1;
      const image: FakeLibraryImage = {
        id: `image-new-${created}`,
        referenceName: typeof attributes.referenceName === 'string' ? attributes.referenceName : null,
        fileName: String(attributes.fileName),
        fileSize: Number(attributes.fileSize),
        state: 'AWAITING_UPLOAD',
        receivedBytes: 0,
        readsUntilProcessed: seed.processingReads ?? 1,
      };
      images.set(image.id, image);
      // Two parts, so the offsets and lengths are exercised, not just one whole-file PUT.
      const firstLength = Math.floor(Number(attributes.fileSize) / 2);
      const operations: UploadOperation[] = [
        { offset: 0, length: firstLength },
        { offset: firstLength, length: Number(attributes.fileSize) - firstLength },
      ].map((part, index) => ({
        method: 'PUT',
        url: `https://uploads.invalid/${image.id}/${index}`,
        ...part,
        requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
      }));
      return respond(201, {
        data: { ...imageResource(image), attributes: { ...imageResource(image).attributes, uploadOperations: operations } },
      });
    }
    if ((match = pathname.match(/^\/appAssetLibraryImages\/([^/]+)$/))) {
      const image = images.get(match[1]);
      if (!image) return refuse(404, 'NOT_FOUND', `no image ${match[1]}`);
      if (method === 'GET') {
        if (image.state === 'UPLOAD_COMPLETE') {
          if (image.readsUntilProcessed > 0) image.readsUntilProcessed -= 1;
          else {
            image.state = (seed.failProcessing ?? []).includes(image.fileName ?? '')
              ? 'FAILED'
              : (seed.processingEndsAs ?? 'PREPARE_FOR_SUBMISSION');
          }
        }
        return respond(200, { data: imageResource(image) });
      }
      if (method === 'PATCH') {
        if (image.receivedBytes !== image.fileSize) {
          return refuse(409, 'ENTITY_ERROR', `received ${image.receivedBytes} bytes, reserved ${image.fileSize}`);
        }
        image.state = 'UPLOAD_COMPLETE';
        return respond(200, { data: imageResource(image) });
      }
      if (method === 'DELETE') {
        if (placements.some((placement) => placement.imageId === image.id)) {
          return refuse(409, 'STATE_ERROR.ASSET_HAS_PLACEMENTS', 'delete its placements first');
        }
        images.delete(image.id);
        return respond(204);
      }
    }
    if (method === 'POST' && pathname === '/appAssetLibraryPlacements') {
      const relationships = write?.data?.relationships ?? {};
      const imageId = (relationships.image?.data as { id?: string } | undefined)?.id ?? '';
      const localizationId = (relationships.appStoreVersionLocalization?.data as { id?: string } | undefined)?.id ?? '';
      const group = String(write?.data?.attributes?.placementGroup ?? '');
      const image = images.get(imageId);
      if (!image) return refuse(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', `no image ${imageId}`);
      if (PROCESSING_STATES.includes(image.state) || image.state === 'FAILED') {
        return refuse(409, 'STATE_ERROR.INVALID_ASSET_STATE', `image is ${image.state}`);
      }
      if (countIn(localizationId, group) >= maxCount) {
        return refuse(409, 'ENTITY_ERROR.LIMIT_EXCEEDED', `${group} already holds ${maxCount}`);
      }
      created += 1;
      const placement: FakePlacement = { id: `placement-new-${created}`, localizationId, group, imageId };
      placements.push(placement);
      return respond(201, {
        data: { type: 'appAssetLibraryPlacements', id: placement.id, attributes: { state: 'ACTIVE' } },
      });
    }
    if ((match = pathname.match(/^\/appAssetLibraryPlacements\/([^/]+)$/)) && method === 'DELETE') {
      const index = placements.findIndex((placement) => placement.id === match?.[1]);
      if (index === -1) return refuse(404, 'NOT_FOUND', `no placement ${match[1]}`);
      const [removed] = placements.splice(index, 1);
      const key = `${removed.localizationId}/${removed.group}`;
      const remaining = countIn(removed.localizationId, removed.group);
      lowestCount.set(key, Math.min(lowestCount.get(key) ?? Number.POSITIVE_INFINITY, remaining));
      return respond(204);
    }
    if (method === 'POST' && pathname === '/appAssetLibraryPlacementOrderingRequests') {
      const relationships = write?.data?.relationships ?? {};
      const orderedIds = ((relationships.orderedPlacements?.data as { id: string }[] | undefined) ?? []).map(
        (linkage) => linkage.id
      );
      const localizationId = (relationships.appStoreVersionLocalization?.data as { id?: string } | undefined)?.id ?? '';
      const group = String(write?.data?.attributes?.placementGroup ?? '');
      const current = placements.filter(
        (placement) => placement.localizationId === localizationId && placement.group === group
      );
      if (current.length !== orderedIds.length || current.some((placement) => !orderedIds.includes(placement.id))) {
        return refuse(409, 'ENTITY_ERROR', 'the ordering does not name exactly the placements in the group');
      }
      if (seed.orderingAppliesAfterReads !== undefined && !seed.ignoreOrdering) {
        deferredOrdering = { current, orderedIds, readsLeft: seed.orderingAppliesAfterReads };
      } else if (!seed.ignoreOrdering) {
        applyOrdering(current, orderedIds);
      }
      return respond(201, { data: { type: 'appAssetLibraryPlacementOrderingRequests', id: 'ordering-1' } });
    }
    return null;
  }

  async function request(method: string, apiPath: string, body?: unknown) {
    return (
      route(method, apiPath, body) ??
      refuse(404, 'Not routed by the fake asset library', `${method} ${apiPath}`)
    );
  }

  async function uploadPart(operation: UploadOperation, bytes: Uint8Array) {
    const imageId = operation.url.split('/')[3];
    const image = images.get(imageId);
    partUploads.push({
      imageId,
      length: bytes.byteLength,
      headers: Object.fromEntries((operation.requestHeaders ?? []).map((header) => [header.name, header.value])),
    });
    if (!image || (seed.failUploadPart ?? []).includes(image.fileName ?? '')) return { ok: false, status: 500 };
    image.receivedBytes += bytes.byteLength;
    return { ok: true, status: 200 };
  }

  /** The reference names a localization shows, in display order. */
  const shownOn = (localizationId: string, group = SCREENSHOT_GROUP) =>
    placements
      .filter((placement) => placement.localizationId === localizationId && placement.group === group)
      .map((placement) => images.get(placement.imageId)?.referenceName ?? images.get(placement.imageId)?.fileName);

  return { route, request, uploadPart, calls, images, placements, partUploads, lowestCount, shownOn };
}

export type FakeAssetLibrary = ReturnType<typeof createFakeAssetLibrary>;

export const libraryWrites = (calls: LibraryCall[]) => calls.filter((call) => call.method !== 'GET');
