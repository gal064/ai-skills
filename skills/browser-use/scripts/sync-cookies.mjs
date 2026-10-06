#!/usr/bin/env node

// One command: check the served source profile, resolve the destination bu
// Chrome (locally or over SSH), tunnel to it, transfer cookies in memory, and
// optionally check a page in the destination.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdpSession, normalizeDomain, webSocketUrlFromCdpUrl, webSocketUrlFromUserDataDir } from './cookie-cdp.mjs';
import { transferCookies } from './transfer-cookies.mjs';

const DEFAULT_SOURCE = path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
const CHECK_MARKER = 'SYNC_CHECK ';

export function parseArgs(argv) {
  const parsed = { domains: [], all: false, sourceUserDataDir: DEFAULT_SOURCE };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--all') {
      parsed.all = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (flag === '--domain') parsed.domains.push(normalizeDomain(value));
    else if (flag === '--to') parsed.to = value;
    else if (flag === '--profile') parsed.profile = value;
    else if (flag === '--source-user-data-dir') parsed.sourceUserDataDir = value;
    else if (flag === '--check') parsed.check = value;
    else if (flag === '--expect') parsed.expect = value;
    else throw new Error(`Unknown argument: ${flag}`);
    index += 1;
  }
  if (!parsed.to) throw new Error('Provide a destination: --to <ssh-host|local>');
  if (!parsed.profile?.trim()) throw new Error('Provide the source profile: --profile <email|profile directory>');
  if (parsed.to.startsWith('-')) throw new Error(`Invalid destination: ${parsed.to}`);
  if (parsed.all === (parsed.domains.length > 0)) {
    throw new Error('Choose exactly one cookie scope: --all or one or more --domain values');
  }
  if (parsed.expect && !parsed.check) throw new Error('--expect requires --check');
  return parsed;
}

export function parseChromeStart(output) {
  const match = /running:\s*(http:\/\/127\.0\.0\.1:(\d+))/.exec(output);
  if (!match) throw new Error(`Could not find a running CDP endpoint in bu output: ${output.trim()}`);
  return { url: match[1], port: Number(match[2]) };
}

export function profileMatches(wanted, profile) {
  const target = wanted.trim().toLowerCase();
  return target === profile.directory.toLowerCase() || target === (profile.userName || '').toLowerCase();
}

// Chrome's debug port only serves cookies for its default profile, so this
// reads which profile that is from chrome://version in a background tab.
export async function resolveServedProfile(userDataDir, dependencies = {}) {
  const session = dependencies.cdpSession || cdpSession;
  const resolveSocket = dependencies.webSocketUrlFromUserDataDir || webSocketUrlFromUserDataDir;
  const read = dependencies.readFile || readFile;
  const socket = await resolveSocket(userDataDir);
  const profilePath = await session(socket, async (send) => {
    const { targetId } = await send('Target.createTarget', { url: 'chrome://version', background: true });
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const { result } = await send('Runtime.evaluate', {
        expression: `new Promise((resolve) => { const poll = () => { const element = document.getElementById('profile_path'); if (element && element.innerText) resolve(element.innerText); else setTimeout(poll, 50); }; poll(); })`,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      return result?.value;
    } finally {
      await send('Target.closeTarget', { targetId }).catch(() => {});
    }
  });
  if (!profilePath) throw new Error('Could not read the source profile path from chrome://version');
  const directory = path.basename(profilePath.trim());
  const localState = JSON.parse(await read(path.join(userDataDir, 'Local State'), 'utf8'));
  return { directory, userName: localState?.profile?.info_cache?.[directory]?.user_name || '' };
}

function runCommand(command, args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 2_000_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} failed: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
    child.stdin.end(input ?? '');
  });
}

function sshArgs(host, remoteCommand) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `bash -lc '${remoteCommand}'`];
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function openTunnel(host, localPort, remotePort) {
  return spawn('ssh', [
    '-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, host,
  ], { stdio: 'ignore' });
}

async function waitForCdp(url, tunnel, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tunnel && tunnel.exitCode !== null) throw new Error(`SSH tunnel exited with code ${tunnel.exitCode}`);
    try {
      await webSocketUrlFromCdpUrl(url, 1_000);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Destination CDP did not answer at ${url} within ${timeoutMs / 1000}s`);
}

export function checkScript(url, expect) {
  const expression = expect === undefined ? 'null' : `document.body.innerText.includes(${JSON.stringify(expect)})`;
  return [
    'import json',
    'new_tab()',
    `goto_url(${JSON.stringify(url)})`,
    'wait_for_load()',
    'try:',
    '    wait_for_network_idle()',
    'except Exception:',
    '    pass',
    'info = page_info()',
    `found = js(${JSON.stringify(expression)})`,
    `print(${JSON.stringify(CHECK_MARKER)} + json.dumps({"url": info.get("url"), "title": info.get("title"), "expectFound": found}))`,
    '',
  ].join('\n');
}

export function parseCheckOutput(output, expect) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(CHECK_MARKER));
  if (!line) throw new Error(`Check produced no result: ${output.trim()}`);
  const result = JSON.parse(line.slice(CHECK_MARKER.length));
  if (expect === undefined) return { url: result.url, title: result.title, loggedIn: 'unknown' };
  return { url: result.url, title: result.title, expectFound: result.expectFound === true };
}

async function runCheck(args, run) {
  const sessionId = `sync_check_${randomBytes(4).toString('hex')}`;
  const bu = (buArgs, input) => args.to === 'local'
    ? run('bu', buArgs, { input })
    : run('ssh', sshArgs(args.to, `bu ${buArgs.join(' ')}`), { input });
  try {
    return parseCheckOutput(await bu([sessionId], checkScript(args.check, args.expect)), args.expect);
  } finally {
    await bu([sessionId, '--end']).catch(() => {});
  }
}

export async function syncCookies(args, dependencies = {}) {
  const run = dependencies.runCommand || runCommand;
  const servedProfile = dependencies.resolveServedProfile || resolveServedProfile;
  const transfer = dependencies.transferCookies || transferCookies;
  const tunnelFactory = dependencies.openTunnel || openTunnel;
  const waitFor = dependencies.waitForCdp || waitForCdp;
  const pickPort = dependencies.freePort || freePort;
  const started = Date.now();

  const profile = await servedProfile(args.sourceUserDataDir);
  if (!profileMatches(args.profile, profile)) {
    throw new Error(`Chrome's debug port serves ${profile.directory} (${profile.userName || 'no account'}), not ${args.profile}. Make ${args.profile} the profile Chrome opened with, then retry.`);
  }

  const chromeStart = args.to === 'local'
    ? await run('bu', ['chrome', 'start'])
    : await run('ssh', sshArgs(args.to, 'bu chrome start'));
  const remote = parseChromeStart(chromeStart);

  let tunnel;
  const closeTunnel = () => { if (tunnel && tunnel.exitCode === null) tunnel.kill(); };
  const onSignal = () => { closeTunnel(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let transferred;
  try {
    let destinationCdpUrl = remote.url;
    if (args.to !== 'local') {
      const localPort = await pickPort();
      tunnel = tunnelFactory(args.to, localPort, remote.port);
      destinationCdpUrl = `http://127.0.0.1:${localPort}`;
    }
    await waitFor(destinationCdpUrl, tunnel);
    transferred = await transfer({
      sourceUserDataDir: args.sourceUserDataDir,
      destinationCdpUrl,
      domains: args.domains,
      all: args.all,
    });
  } finally {
    closeTunnel();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  const result = {
    profile: `${profile.directory} (${profile.userName || 'no account'})`,
    destination: args.to,
    ...transferred,
  };
  if (args.check) {
    // The cookies are already merged, so a failed check must not hide that.
    result.check = await runCheck(args, run).catch((error) => ({ error: error.message }));
  }
  result.seconds = Math.round((Date.now() - started) / 100) / 10;
  return result;
}

async function main() {
  const result = await syncCookies(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`cookie sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}
