import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cdpSession } from './cookie-cdp.mjs';

export async function managedBrowserConnection(profile, stateFile, endpoint, dependencies = {}) {
  const request = dependencies.fetch || fetch;
  const pause = dependencies.delay || delay;
  const probe = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await request(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
        if (!response.ok) throw new Error(`CDP returned HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        if (error.cause?.code === 'ECONNREFUSED') return null;
        // Chrome can reset a pooled HTTP socket while quitting. Retry those
        // transport errors, then require connection refusal as proof of exit.
        if (attempt >= 2 || !['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(error.cause?.code)) throw error;
        await pause(100);
      }
    }
  };
  const marker = await readFile(path.join(profile, '.bu-dedicated-profile'), 'utf8');
  if (marker.trim() !== 'managed-by=browser-use-skill') throw new Error('dedicated profile ownership is unconfirmed');
  const [port, browserPath, recordedProfile] = (await readFile(stateFile, 'utf8')).trimEnd().split('\n');
  if (recordedProfile !== profile || !/^\d+$/.test(port) || !browserPath?.startsWith('/devtools/browser/') ||
      endpoint !== `http://127.0.0.1:${port}`) throw new Error('profile endpoint ownership is unconfirmed');
  const expectedSocket = `ws://127.0.0.1:${port}${browserPath}`;
  const version = await probe();
  if (version === null) return { socket: null, probe };
  if (version.webSocketDebuggerUrl !== expectedSocket) throw new Error('browser identity changed');
  return { socket: expectedSocket, probe };
}

// Only the wrapper calls this while holding the profile lifecycle lock.
// Session cleanup is still successful when closing Chrome is unsafe or fails.
export async function closeUnusedChrome(profile, stateFile, endpoint, dependencies = {}) {
  const connect = dependencies.cdpSession || cdpSession;
  const pause = dependencies.delay || delay;
  const warn = dependencies.warn || ((message) => console.error(`bu: Chrome left running: ${message}`));

  try {
    const { socket: expectedSocket, probe } = await managedBrowserConnection(profile, stateFile, endpoint, dependencies);
    if (expectedSocket === null) {
      await unlink(stateFile);
      return;
    }
    await connect(expectedSocket, async (send) => {
      // Tab closure is asynchronous. Give this session's closing targets a
      // short chance to disappear; any remaining page blocks browser exit.
      for (let attempt = 0; attempt < 10; attempt++) {
        const { targetInfos } = await send('Target.getTargets');
        if (!Array.isArray(targetInfos)) throw new Error('could not enumerate browser targets');
        if (!targetInfos.some((target) => target.type === 'page')) {
          try {
            await send('Browser.close');
          } catch {
            // Chrome may drop the socket before acknowledging Browser.close.
            // The HTTP probe below decides whether it actually exited.
          }
          return;
        }
        await pause(100);
      }
      throw new Error('page tabs remain open');
    }, 1000);
    for (let attempt = 0; attempt < 25; attempt++) {
      if (await probe() === null) {
        await unlink(stateFile);
        return;
      }
      await pause(200);
    }
    throw new Error('browser did not exit');
  } catch (error) {
    warn(error.message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await closeUnusedChrome(...process.argv.slice(2));
}
