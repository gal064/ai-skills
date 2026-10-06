#!/usr/bin/env node

import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function isDirectory(candidate) {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function executable(candidate) {
  try {
    await access(candidate, 1);
    return await realpath(candidate);
  } catch {
    return null;
  }
}

function commandPath(command, pathEnv) {
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return '';
}

export function browserDefinitions(platform, home) {
  if (platform === 'darwin') {
    return [
      ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(home, 'Library/Application Support/Google/Chrome')],
      ['Google Chrome Canary', '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary', path.join(home, 'Library/Application Support/Google/Chrome Canary')],
      ['Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium', path.join(home, 'Library/Application Support/Chromium')],
      ['Brave Browser', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser')],
      ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', path.join(home, 'Library/Application Support/Microsoft Edge')],
    ].map(([name, binary, userDataDir]) => ({ name, binary, userDataDir }));
  }
  if (platform === 'linux') {
    return [
      ['Google Chrome', 'google-chrome-stable', '.config/google-chrome'],
      ['Google Chrome', 'google-chrome', '.config/google-chrome'],
      ['Chromium', 'chromium', '.config/chromium'],
      ['Chromium', 'chromium-browser', '.config/chromium'],
      ['Brave Browser', 'brave-browser', '.config/BraveSoftware/Brave-Browser'],
      ['Microsoft Edge', 'microsoft-edge-stable', '.config/microsoft-edge'],
      ['Microsoft Edge', 'microsoft-edge', '.config/microsoft-edge'],
    ].map(([name, command, relativeDataDir]) => ({ name, command, userDataDir: path.join(home, relativeDataDir) }));
  }
  throw new Error(`Unsupported platform: ${platform}; browser-use installation supports Linux and macOS`);
}

async function readProfileInfo(browser) {
  let localState;
  try {
    localState = JSON.parse(await readFile(path.join(browser.userDataDir, 'Local State'), 'utf8'));
  } catch {
    return [];
  }
  const infoCache = localState?.profile?.info_cache;
  if (!infoCache || typeof infoCache !== 'object' || Array.isArray(infoCache)) return [];
  const profiles = [];
  for (const [directory, info] of Object.entries(infoCache)) {
    const profilePath = path.join(browser.userDataDir, directory);
    if (!(await isDirectory(profilePath))) continue;
    profiles.push({
      browser: browser.name,
      browserBinary: browser.binary,
      profileDirectory: directory,
      displayName: typeof info?.name === 'string' ? info.name : directory,
      userName: typeof info?.user_name === 'string' ? info.user_name : '',
      profilePath,
      userDataDir: browser.userDataDir,
    });
  }
  return profiles;
}

async function readDedicatedProfiles(configHome) {
  const root = path.join(configHome, 'browser-use');
  const candidates = [path.join(root, 'default-profile')];
  const namedRoot = path.join(root, 'profiles');
  try {
    for (const entry of await readdir(namedRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(namedRoot, entry.name));
    }
  } catch {}
  try {
    for (const line of (await readFile(path.join(root, 'bu.conf'), 'utf8')).split('\n')) {
      if (line.startsWith('profile_dir=')) candidates.push(line.slice('profile_dir='.length));
    }
  } catch {}
  const found = [];
  for (const candidate of candidates) {
    if (!(await isDirectory(candidate))) continue;
    const resolved = await realpath(candidate);
    if (!found.some((item) => item.path === resolved)) {
      found.push({ name: path.basename(resolved), path: resolved });
    }
  }
  return found;
}

export async function discoverBrowserConfig({
  platform = process.platform,
  home = os.homedir(),
  configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
  pathEnv = process.env.PATH || '',
} = {}) {
  const browsers = [];
  for (const definition of browserDefinitions(platform, home)) {
    const candidate = definition.binary || commandPath(definition.command, pathEnv);
    if (!candidate) continue;
    const binary = await executable(candidate);
    if (!binary || browsers.some((item) => item.binary === binary)) continue;
    browsers.push({ name: definition.name, binary, userDataDir: definition.userDataDir });
  }
  const sourceProfiles = (await Promise.all(browsers.map(readProfileInfo))).flat();
  const dedicatedProfiles = await readDedicatedProfiles(configHome);
  return { platform, browsers, dedicatedProfiles, sourceProfiles };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  discoverBrowserConfig()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(`browser-use discovery: ${error.message}`);
      process.exitCode = 1;
    });
}
