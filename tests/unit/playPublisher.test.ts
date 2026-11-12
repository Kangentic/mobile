/**
 * scripts/lib/playPublisher.mjs: the Google service-account sign-in and the
 * transport the Play release scripts share.
 *
 * The sign-in was moved here out of scripts/checkPlayVersionCode.mjs, which had
 * no test at all and runs inside a required check ("Release counters (stores)")
 * whose Play step only executes on a pull request that changes a counter. So a
 * broken import there would not surface on the pull request that broke it. The
 * last group runs that script for real, far enough to prove it still loads.
 *
 * Uses a locally generated RSA key, so no real credential and no network call.
 */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PLAY_API_BASE,
  PLAY_UPLOAD_BASE,
  PUBLISHER_SCOPE,
  TOKEN_ENDPOINT,
  createPlayRequest,
  createServiceAccountAssertion,
  readServiceAccount,
} from '../../scripts/lib/playPublisher.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = {
  client_email: 'publisher@example-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function writeTemporaryFile(name: string, text: string): string {
  const filePath = join(mkdtempSync(join(tmpdir(), 'play-key-')), name);
  writeFileSync(filePath, text);
  return filePath;
}

describe('createServiceAccountAssertion', () => {
  const issuedAt = 1_800_000_000;
  const assertion: string = createServiceAccountAssertion(serviceAccount, issuedAt);
  const [encodedHeader, encodedClaims, encodedSignature] = assertion.split('.');

  it('produces three base64url segments with no padding', () => {
    expect(assertion.split('.')).toHaveLength(3);
    expect(assertion).not.toMatch(/[+/=]/);
  });

  it('declares RS256', () => {
    expect(decodeSegment(encodedHeader)).toEqual({ alg: 'RS256', typ: 'JWT' });
  });

  it('asks for the publisher scope, as the service account, for one hour', () => {
    expect(decodeSegment(encodedClaims)).toEqual({
      iss: serviceAccount.client_email,
      scope: PUBLISHER_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
    });
  });

  it('is signed by the service account key', () => {
    const verified = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      publicKey,
      Buffer.from(encodedSignature, 'base64url')
    );
    expect(verified).toBe(true);
  });
});

describe('readServiceAccount', () => {
  it('reads a key file', () => {
    const keyPath = writeTemporaryFile('key.json', JSON.stringify(serviceAccount));
    expect(readServiceAccount(keyPath).client_email).toBe(serviceAccount.client_email);
  });

  it('does not echo a malformed key into the error', () => {
    // JSON.parse quotes the start of what it could not parse, and this file is a
    // private key on its way into a public CI log.
    const keyPath = writeTemporaryFile('key.json', 'SECRET-KEY-MATERIAL-that-is-not-json');
    let message = '';
    try {
      readServiceAccount(keyPath);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/could not be read as JSON/);
    expect(message).not.toContain('SECRET');
  });

  it('refuses a JSON file that is not a service-account key', () => {
    const keyPath = writeTemporaryFile('key.json', JSON.stringify({ type: 'authorized_user' }));
    expect(() => readServiceAccount(keyPath)).toThrow(/no client_email or private_key/);
  });
});

describe('createPlayRequest', () => {
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

  it('sends an API call to the applications collection with the bearer token and no body', async () => {
    const fetchStub = stubFetch(200, '{"id":"edit-1"}');
    const response = await createPlayRequest('token-1')('POST', '/com.example.app/edits');

    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`${PLAY_API_BASE}/com.example.app/edits`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1' });
    expect(response).toEqual({ ok: true, status: 200, body: { id: 'edit-1' } });
  });

  it('sends an upload to the same path under /upload/, as a simple media upload of the raw bytes', async () => {
    const fetchStub = stubFetch(200, '{"image":{"id":"image-1"}}');
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await createPlayRequest('token-1')('POST', '/com.example.app/edits/e1/listings/en-US/phoneScreenshots', {
      bytes,
      contentType: 'image/png',
    });

    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe(`${PLAY_UPLOAD_BASE}/com.example.app/edits/e1/listings/en-US/phoneScreenshots?uploadType=media`);
    expect(init.body).toBe(bytes);
    expect(init.headers).toEqual({ Authorization: 'Bearer token-1', 'Content-Type': 'image/png' });
  });

  it('reads an empty 204 as an empty body, and keeps a non-JSON error page readable', async () => {
    stubFetch(204, '');
    expect(await createPlayRequest('token-1')('DELETE', '/x/edits/e1')).toEqual({ ok: true, status: 204, body: {} });

    stubFetch(502, '<html>Bad Gateway</html>');
    expect(await createPlayRequest('token-1')('GET', '/x/edits/e1')).toEqual({
      ok: false,
      status: 502,
      body: { raw: '<html>Bad Gateway</html>' },
    });
  });
});

describe('scripts/checkPlayVersionCode.mjs still runs after the sign-in moved out of it', () => {
  const script = join(repositoryRoot, 'scripts', 'checkPlayVersionCode.mjs');
  const run = (scriptArguments: string[]) =>
    spawnSync(process.execPath, [script, ...scriptArguments], { cwd: repositoryRoot, encoding: 'utf8', timeout: 30_000 });

  it('loads, and reports a missing argument before any network call', () => {
    // An import that no longer resolves fails here with a module error on
    // stderr instead of this message.
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing required argument --key.');
  });

  it('reports an unreadable key without echoing it', () => {
    const keyPath = writeTemporaryFile('key.json', 'SECRET-KEY-MATERIAL-that-is-not-json');
    const result = run(['--key', keyPath, '--package', 'com.example.app', '--version-code', '7']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/could not be read as JSON/);
    expect(result.stderr).not.toContain('SECRET');
  });
});
