/**
 * Wire shapes for the dev-only mobile inspect loop: a tiny JSON
 * request/response protocol between the app's in-process bridge
 * (inspectBridge.ts, dev builds only) and scripts/mobileInspect.mjs, which
 * hosts a local WebSocket server the app dials OUT to over `adb reverse`.
 * The .mjs script mirrors these shapes by hand (scripts cannot import TS),
 * the same arrangement as the xterm WebView glue.
 */

/** Loopback-only; reachable from the emulator solely via `adb reverse tcp:8791`. */
export const INSPECT_PORT = 8791;

export const INSPECT_REQUEST_KINDS = [
  'connection',
  'stores',
  'subscriptions',
  'feed-stats',
  'route',
  'pairing',
  /** Canned geometry/mode/gesture dump from the mounted terminal WebView. */
  'terminal',
  /** Arbitrary expression evaluated inside that WebView; `argument` carries it. */
  'terminal-eval',
] as const;
export type InspectRequestKind = (typeof INSPECT_REQUEST_KINDS)[number];

export interface InspectRequest {
  type: 'request';
  id: string;
  kind: InspectRequestKind;
  /** Only 'terminal-eval' reads this; every other kind ignores it. */
  argument?: string;
}

export interface InspectResponse {
  type: 'response';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export interface InspectHello {
  type: 'hello';
  app: string;
}

function isInspectRequestKind(value: unknown): value is InspectRequestKind {
  return typeof value === 'string' && (INSPECT_REQUEST_KINDS as readonly string[]).includes(value);
}

/** Tolerant decode: anything malformed is null (the bridge ignores it). */
export function decodeInspectRequest(raw: unknown): InspectRequest | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (candidate.type !== 'request') return null;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null;
  if (!isInspectRequestKind(candidate.kind)) return null;
  const request: InspectRequest = { type: 'request', id: candidate.id, kind: candidate.kind };
  if (typeof candidate.argument === 'string') request.argument = candidate.argument;
  return request;
}

export function encodeInspectResponse(response: InspectResponse): string {
  return JSON.stringify(response);
}

export function encodeInspectHello(): string {
  const hello: InspectHello = { type: 'hello', app: 'kangentic-mobile' };
  return JSON.stringify(hello);
}
