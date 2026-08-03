import { describe, expect, it } from 'vitest';
import {
  decodeInspectRequest,
  encodeInspectHello,
  encodeInspectResponse,
  INSPECT_REQUEST_KINDS,
} from '../../src/devsupport/inspectProtocol';

describe('inspectProtocol', () => {
  it('round-trips a request for every kind', () => {
    for (const kind of INSPECT_REQUEST_KINDS) {
      const raw = JSON.stringify({ type: 'request', id: 'req-1', kind });
      expect(decodeInspectRequest(raw)).toEqual({ type: 'request', id: 'req-1', kind });
    }
  });

  it('rejects malformed input as null', () => {
    expect(decodeInspectRequest('not json')).toBeNull();
    expect(decodeInspectRequest(JSON.stringify({ type: 'request', id: 'x', kind: 'no-such-kind' }))).toBeNull();
    expect(decodeInspectRequest(JSON.stringify({ type: 'response', id: 'x', kind: 'route' }))).toBeNull();
    expect(decodeInspectRequest(JSON.stringify({ type: 'request', id: '', kind: 'route' }))).toBeNull();
    expect(decodeInspectRequest(JSON.stringify(null))).toBeNull();
    expect(decodeInspectRequest(12 as unknown as string)).toBeNull();
  });

  it('round-trips a terminal-eval request and carries its argument', () => {
    const raw = JSON.stringify({ type: 'request', id: 'req-eval-1', kind: 'terminal-eval', argument: '1+1' });
    const decoded = decodeInspectRequest(raw);
    expect(decoded).toStrictEqual({ type: 'request', id: 'req-eval-1', kind: 'terminal-eval', argument: '1+1' });
  });

  it('decodes a request without an argument field without adding one', () => {
    const raw = JSON.stringify({ type: 'request', id: 'req-no-arg', kind: 'terminal-eval' });
    const decoded = decodeInspectRequest(raw);
    expect(decoded).toStrictEqual({ type: 'request', id: 'req-no-arg', kind: 'terminal-eval' });
    expect(decoded).not.toBeNull();
    expect(decoded && 'argument' in decoded).toBe(false);
  });

  it('encodes responses and the hello as parseable JSON', () => {
    const response = JSON.parse(
      encodeInspectResponse({ type: 'response', id: 'req-2', ok: true, payload: { answer: 42 } }),
    ) as Record<string, unknown>;
    expect(response).toEqual({ type: 'response', id: 'req-2', ok: true, payload: { answer: 42 } });

    const hello = JSON.parse(encodeInspectHello()) as Record<string, unknown>;
    expect(hello).toEqual({ type: 'hello', app: 'kangentic-mobile' });
  });
});
