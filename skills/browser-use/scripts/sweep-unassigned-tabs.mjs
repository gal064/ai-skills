import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cdpSession } from './cookie-cdp.mjs';
import { managedBrowserConnection } from './close-unused-chrome.mjs';

async function registeredStores(runtime, currentStore) {
  const stores = new Set([currentStore]);
  try {
    for (const name of await readdir(path.join(runtime, 'session-stores'))) {
      const store = (await readFile(path.join(runtime, 'session-stores', name), 'utf8')).trimEnd();
      if (!path.isAbsolute(store)) throw new Error('registered session store has an ambiguous relative path');
      stores.add(store);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return stores;
}

async function assignedTabs(stores) {
  const assigned = new Set();
  for (const store of stores) {
    try {
      const info = await stat(store);
      if (!info.isDirectory()) throw new Error('session store is not a directory');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const directory = path.join(store, 'sessions');
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names.filter((name) => name.endsWith('.tabs'))) {
      // A record that cannot be read is unknown ownership, never an empty set.
      for (const id of (await readFile(path.join(directory, name), 'utf8')).split(/\s+/).filter(Boolean)) assigned.add(id);
    }
  }
  return assigned;
}

async function anotherCommandRunning(runtime, callerPid, isRunning) {
  let names;
  try {
    names = await readdir(path.join(runtime, 'calls'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  return names.some((name) => /^\d+$/.test(name) && Number(name) !== callerPid && isRunning(Number(name)));
}

function processRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denied still proves that a process exists.
    return error.code !== 'ESRCH';
  }
}

// Called only under the wrapper's profile lifecycle lock, before user code
// (observe) or after it (sweep), and during explicit session cleanup.
// No watcher or browser-wide age heuristic.
export async function sweepUnassignedTabs(profile, stateFile, endpoint, currentStore, callerPid, mode, ttl, dependencies = {}) {
  const warn = dependencies.warn || ((message) => console.error(`bu: unassigned-tab cleanup skipped: ${message}`));
  const now = dependencies.now || Date.now;
  const connect = dependencies.cdpSession || cdpSession;
  const running = dependencies.processRunning || processRunning;
  const runtime = path.dirname(stateFile);
  const inventoryFile = path.join(runtime, 'unassigned-tabs.json');
  const seconds = /^\d+$/.test(String(ttl)) ? Number(ttl) : 3600;
  const temporary = `${inventoryFile}.${process.pid}.tmp`;
  try {
    if (!['observe', 'sweep'].includes(mode)) throw new Error('invalid cleanup mode');
    const { socket } = await managedBrowserConnection(profile, stateFile, endpoint, dependencies);
    if (socket === null) {
      await unlink(inventoryFile).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      return;
    }
    const stores = await registeredStores(runtime, currentStore);
    const assigned = await assignedTabs(stores);
    const active = await anotherCommandRunning(runtime, Number(callerPid), running);
    let previous = {};
    try {
      previous = JSON.parse(await readFile(inventoryFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      // A missing or malformed inventory starts fresh clocks; never guess age.
    }
    const observedAt = now();
    const priorTimes = previous?.browser === socket ? previous.firstSeen : null;
    await connect(socket, async (send) => {
      const { targetInfos } = await send('Target.getTargets');
      if (!Array.isArray(targetInfos)) throw new Error('could not enumerate browser targets');
      const firstSeen = {};
      for (const target of targetInfos) {
        if (target.type !== 'page' || typeof target.targetId !== 'string' || assigned.has(target.targetId)) continue;
        const prior = priorTimes?.[target.targetId];
        firstSeen[target.targetId] = Number.isFinite(prior) && prior >= 0 && prior <= observedAt ? prior : observedAt;
      }
      // Publish observation before closing anything: Chrome may exit as its
      // final page closes, disconnecting CDP before the callback returns.
      await writeFile(temporary, JSON.stringify({ browser: socket, firstSeen }) + '\n', { mode: 0o600 });
      await rename(temporary, inventoryFile);
      if (mode !== 'sweep' || seconds === 0 || active) return;
      for (const [targetId, firstObserved] of Object.entries(firstSeen)) {
        if (observedAt - firstObserved >= seconds * 1000) await send('Target.closeTarget', { targetId });
      }
    }, 1000);
  } catch (error) {
    // Chrome may exit between its last tab closing and this optional check.
    if (error.code !== 'ENOENT' && error.cause?.code !== 'ECONNREFUSED') warn(error.message);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await sweepUnassignedTabs(...process.argv.slice(2));
}
