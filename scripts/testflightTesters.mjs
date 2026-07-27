#!/usr/bin/env node
/**
 * Manage TestFlight beta groups and testers from the command line, so adding
 * people is not a click-path through App Store Connect.
 *
 * Zero dependencies, and it reuses the ES256 JWT from checkAppStoreBuild.mjs
 * rather than reimplementing it. See that file for why the signature encoding is
 * the part that goes wrong (`dsaEncoding: 'ieee-p1363'`, not the DER default).
 *
 * INTERNAL VS EXTERNAL, which decides what you can actually do here:
 *
 * - **External** testers are just an email address. They get the app and nothing
 *   else. Up to 10,000. The cost is that the first build distributed to an
 *   external group needs **Beta App Review**, which needs beta app info filled in
 *   (description, feedback email, what to test).
 * - **Internal** testers must be App Store Connect **users on your team**, so
 *   adding one means granting account access, role-scoped. Up to 100. No review:
 *   builds are available as soon as they finish processing.
 *
 * This script manages testers and groups. It deliberately does NOT invite App
 * Store Connect users, because that grants access to the account rather than to a
 * build, and it should be a deliberate click by a human who can see the role
 * picker.
 *
 * Usage:
 *   node scripts/testflightTesters.mjs list
 *   node scripts/testflightTesters.mjs create-group --name "Beta"
 *   node scripts/testflightTesters.mjs add --group "Beta" --email a@b.com [--first Ada --last Lovelace]
 *   node scripts/testflightTesters.mjs add --group "Beta" --emails-file testers.txt
 *   node scripts/testflightTesters.mjs remove --email a@b.com
 *
 * Credentials come from the same place the release workflow uses. Either pass
 * them, or set ASC_KEY_PATH / ASC_KEY_ID / ASC_ISSUER_ID:
 *   --key <AuthKey.p8> --key-id <kid> --issuer-id <iss>
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createAppStoreConnectToken } from './checkAppStoreBuild.mjs';

const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1';
const BUNDLE_ID = 'com.kangentic.mobile';

function parseArguments(argv) {
  const command = argv[0];
  const parsed = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) throw new Error(`Malformed argument near "${flag}".`);
    parsed[flag.slice(2)] = argv[index + 1];
  }
  return { command, options: parsed };
}

function resolveCredentials(options) {
  const keyPath = options.key ?? process.env.ASC_KEY_PATH;
  const keyId = options['key-id'] ?? process.env.ASC_KEY_ID;
  const issuerId = options['issuer-id'] ?? process.env.ASC_ISSUER_ID;
  if (!keyPath || !keyId || !issuerId) {
    throw new Error(
      'Missing credentials. Pass --key/--key-id/--issuer-id, or set ASC_KEY_PATH/ASC_KEY_ID/ASC_ISSUER_ID. ' +
        'See the credential inventory in docs/developer-guide.md.'
    );
  }
  return createAppStoreConnectToken(readFileSync(keyPath, 'utf8'), keyId, issuerId);
}

async function callApi(token, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${ASC_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // 204 No Content is the success shape for a DELETE.
  const payload = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    const detail = Array.isArray(payload.errors)
      ? payload.errors.map((error) => `${error.title}: ${error.detail ?? ''}`.trim()).join('; ')
      : JSON.stringify(payload);
    throw new Error(`${method} ${path} failed (${response.status}): ${detail}`);
  }
  return payload;
}

async function resolveAppId(token) {
  const apps = await callApi(token, `/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
  const app = apps.data?.[0];
  if (!app) throw new Error(`App Store Connect has no app with bundle id ${BUNDLE_ID}.`);
  return app.id;
}

async function findGroupByName(token, appId, name) {
  const groups = await callApi(token, `/apps/${appId}/betaGroups?limit=200`);
  return (groups.data ?? []).find((group) => group.attributes?.name === name) ?? null;
}

async function listEverything(token, appId) {
  const groups = await callApi(token, `/apps/${appId}/betaGroups?limit=200`);
  process.stdout.write('Beta groups:\n');
  for (const group of groups.data ?? []) {
    const attributes = group.attributes ?? {};
    const kind = attributes.isInternalGroup ? 'internal' : 'external';
    process.stdout.write(
      `  ${attributes.name}  [${kind}]  id=${group.id}` +
        `${attributes.hasAccessToAllBuilds ? '  (all builds)' : ''}` +
        `${attributes.publicLinkEnabled ? `  public link: ${attributes.publicLink}` : ''}\n`
    );
  }
  if ((groups.data ?? []).length === 0) process.stdout.write('  (none)\n');

  const testers = await callApi(token, `/betaTesters?filter[apps]=${appId}&limit=200`);
  process.stdout.write(`\nTesters (${(testers.data ?? []).length}):\n`);
  for (const tester of testers.data ?? []) {
    const attributes = tester.attributes ?? {};
    const name = [attributes.firstName, attributes.lastName].filter(Boolean).join(' ');
    process.stdout.write(`  ${attributes.email}${name ? `  (${name})` : ''}  invite=${attributes.inviteType}\n`);
  }
  if ((testers.data ?? []).length === 0) process.stdout.write('  (none)\n');
}

async function createGroup(token, appId, name) {
  if (!name) throw new Error('create-group needs --name.');
  if (await findGroupByName(token, appId, name)) {
    process.stdout.write(`Group "${name}" already exists; nothing to do.\n`);
    return;
  }
  // Created as EXTERNAL deliberately. An internal group's members must be App
  // Store Connect users, which this script does not create (see the header).
  const created = await callApi(token, '/betaGroups', {
    method: 'POST',
    body: {
      data: {
        type: 'betaGroups',
        attributes: { name, publicLinkEnabled: false },
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    },
  });
  process.stdout.write(`Created external group "${name}" (id ${created.data.id}).\n`);
  process.stdout.write(
    'Remember: the first build distributed to an EXTERNAL group needs Beta App Review, which needs ' +
      'beta app info (description, feedback email, what to test) filled in first.\n'
  );
}

function readEmails(options) {
  if (options['emails-file']) {
    return readFileSync(options['emails-file'], 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }
  if (options.email) return [options.email];
  throw new Error('add needs --email or --emails-file.');
}

async function addTesters(token, appId, options) {
  const groupName = options.group;
  if (!groupName) throw new Error('add needs --group.');
  const group = await findGroupByName(token, appId, groupName);
  if (!group) {
    throw new Error(`No beta group named "${groupName}". Run \`list\` to see them, or create it first.`);
  }

  for (const email of readEmails(options)) {
    try {
      await callApi(token, '/betaTesters', {
        method: 'POST',
        body: {
          data: {
            type: 'betaTesters',
            attributes: {
              email,
              ...(options.first ? { firstName: options.first } : {}),
              ...(options.last ? { lastName: options.last } : {}),
            },
            relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } },
          },
        },
      });
      process.stdout.write(`Added ${email} to "${groupName}".\n`);
    } catch (error) {
      // An existing tester is not a failure worth aborting a batch for: the
      // common case is re-running the same list after adding one name to it.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('409') || message.toLowerCase().includes('already exists')) {
        process.stdout.write(`${email} is already a tester; skipped.\n`);
        continue;
      }
      throw error;
    }
  }
}

async function removeTester(token, appId, email) {
  if (!email) throw new Error('remove needs --email.');
  const testers = await callApi(token, `/betaTesters?filter[apps]=${appId}&filter[email]=${encodeURIComponent(email)}`);
  const tester = testers.data?.[0];
  if (!tester) {
    process.stdout.write(`No tester with email ${email}; nothing to do.\n`);
    return;
  }
  await callApi(token, `/betaTesters/${tester.id}`, { method: 'DELETE' });
  process.stdout.write(`Removed ${email}.\n`);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const token = resolveCredentials(options);
  const appId = await resolveAppId(token);

  switch (command) {
    case 'list':
      return listEverything(token, appId);
    case 'create-group':
      return createGroup(token, appId, options.name);
    case 'add':
      return addTesters(token, appId, options);
    case 'remove':
      return removeTester(token, appId, options.email);
    default:
      throw new Error(
        `Unknown command "${command ?? ''}". Expected: list, create-group, add, remove. See the header for usage.`
      );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
