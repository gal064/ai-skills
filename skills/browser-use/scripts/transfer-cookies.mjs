#!/usr/bin/env node

import {
  cdpRequest,
  cookieKey,
  domainAllowed,
  normalizeDomain,
  normalizeOrigin,
  readLocalStorage,
  toCookieParam,
  webSocketUrlFromCdpUrl,
  webSocketUrlFromUserDataDir,
  writeLocalStorage,
} from './cookie-cdp.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const parsed = { domains: [], all: false, localStorageOrigins: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--all') {
      parsed.all = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--source-cdp-url') parsed.sourceCdpUrl = value;
    else if (flag === '--source-user-data-dir') parsed.sourceUserDataDir = value;
    else if (flag === '--destination-cdp-url') parsed.destinationCdpUrl = value;
    else if (flag === '--destination-user-data-dir') parsed.destinationUserDataDir = value;
    else if (flag === '--domain') parsed.domains.push(normalizeDomain(value));
    else if (flag === '--local-storage-origin') parsed.localStorageOrigins.push(normalizeOrigin(value));
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  if (Boolean(parsed.sourceCdpUrl) === Boolean(parsed.sourceUserDataDir)) {
    throw new Error('Provide exactly one source endpoint: --source-cdp-url or --source-user-data-dir');
  }
  if (Boolean(parsed.destinationCdpUrl) === Boolean(parsed.destinationUserDataDir)) {
    throw new Error('Provide exactly one destination endpoint: --destination-cdp-url or --destination-user-data-dir');
  }
  if (parsed.all === (parsed.domains.length > 0)) {
    throw new Error('Choose exactly one cookie scope: --all or one or more --domain values');
  }
  return parsed;
}

async function endpoint(args, side, resolveCdpUrl, resolveUserDataDir) {
  const cdpUrl = args[`${side}CdpUrl`];
  if (cdpUrl) return await resolveCdpUrl(cdpUrl);
  return await resolveUserDataDir(args[`${side}UserDataDir`]);
}

export async function transferCookies(args, dependencies = {}) {
  const request = dependencies.cdpRequest || cdpRequest;
  const resolveCdpUrl = dependencies.webSocketUrlFromCdpUrl || webSocketUrlFromCdpUrl;
  const resolveUserDataDir = dependencies.webSocketUrlFromUserDataDir || webSocketUrlFromUserDataDir;
  const sourceSocket = await endpoint(args, 'source', resolveCdpUrl, resolveUserDataDir);
  const destinationSocket = await endpoint(args, 'destination', resolveCdpUrl, resolveUserDataDir);
  const sourceResult = await request(sourceSocket, 'Storage.getCookies');
  if (!Array.isArray(sourceResult?.cookies)) throw new Error('Source CDP returned no cookie array');
  const selected = args.all
    ? sourceResult.cookies
    : sourceResult.cookies.filter((cookie) => domainAllowed(cookie.domain, args.domains));
  if (selected.length === 0) throw new Error('No source cookies matched the confirmed scope');
  const opaquePartitionedCount = selected.filter((cookie) => cookie.partitionKeyOpaque === true).length;
  if (opaquePartitionedCount > 0) {
    throw new Error(`Refusing to transfer ${opaquePartitionedCount} opaque partitioned cookie(s)`);
  }
  // Read every origin before writing anything, so an empty one fails cleanly.
  const localStorageSources = await readLocalStorageSources(sourceSocket, args.localStorageOrigins || [], dependencies);

  await request(destinationSocket, 'Storage.setCookies', { cookies: selected.map(toCookieParam) });
  const destinationResult = await request(destinationSocket, 'Storage.getCookies');
  const destinationByKey = new Map((destinationResult?.cookies || []).map((cookie) => [cookieKey(cookie), cookie.value]));
  const unverified = selected.filter((cookie) => destinationByKey.get(cookieKey(cookie)) !== cookie.value);
  if (unverified.length > 0) {
    throw new Error(`Only ${selected.length - unverified.length} of ${selected.length} cookies verified`);
  }
  const result = {
    scope: args.all ? 'all' : 'domains',
    imported: selected.length,
    verified: selected.length,
    sourceTotal: sourceResult.cookies.length,
  };
  if (localStorageSources.length > 0) {
    result.localStorage = await writeLocalStorageSources(destinationSocket, localStorageSources, dependencies);
  }
  return result;
}

// Reads every localStorage key of each confirmed origin.
export async function readLocalStorageSources(sourceSocket, origins, dependencies = {}) {
  const read = dependencies.readLocalStorage || readLocalStorage;
  const sources = [];
  for (const origin of origins) {
    const entries = await read(sourceSocket, origin);
    if (entries.length === 0) throw new Error(`No source localStorage entries for ${origin}`);
    sources.push([origin, entries]);
  }
  return sources;
}

// Merges each origin's entries into the destination without clearing keys it
// already has, then verifies every entry.
export async function writeLocalStorageSources(destinationSocket, sources, dependencies = {}) {
  const write = dependencies.writeLocalStorage || writeLocalStorage;
  const results = [];
  for (const [origin, entries] of sources) {
    const destination = new Map(await write(destinationSocket, origin, entries));
    const verified = entries.filter(([key, value]) => destination.get(key) === value).length;
    if (verified !== entries.length) {
      throw new Error(`Only ${verified} of ${entries.length} localStorage entries verified for ${origin}`);
    }
    results.push({ origin, imported: entries.length, verified });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await transferCookies(args);
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`cookie transfer failed: ${error.message}`);
    process.exitCode = 1;
  });
}
