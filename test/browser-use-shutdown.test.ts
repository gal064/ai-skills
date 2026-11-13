import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Local JavaScript helper follows the skill's existing script convention.
import { closeUnusedChrome } from '../skills/browser-use/scripts/close-unused-chrome.mjs';

const exec = promisify(execFile);
const wrapper = path.resolve(import.meta.dirname, '../skills/browser-use/bin/bu');
const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bu-final-session-'));
  roots.push(root);
  return root;
}

async function executable(file: string, content: string) {
  await writeFile(file, content);
  await chmod(file, 0o700);
}

async function helperFixture() {
  const root = await temporaryRoot();
  const state = path.join(root, 'DevToolsActivePort');
  await writeFile(path.join(root, '.bu-dedicated-profile'), 'managed-by=browser-use-skill\n');
  await writeFile(state, `45123\n/devtools/browser/test\n${root}\n`);
  const sent: string[] = [];
  const warn = vi.fn();
  let running = true;
  let targets: { type: string }[] = [{ type: 'service_worker' }];
  let identity = 'ws://127.0.0.1:45123/devtools/browser/test';
  const refused = () => Object.assign(new Error('connection refused'), { cause: { code: 'ECONNREFUSED' } });
  const dependencies = {
    warn,
    delay: async () => {},
    fetch: vi.fn(async () => {
      if (!running) throw refused();
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: identity }) };
    }),
    cdpSession: vi.fn(async (_socket: string, callback: (send: (method: string) => Promise<unknown>) => Promise<void>) => {
      await callback(async (method: string) => {
        sent.push(method);
        if (method === 'Target.getTargets') return { targetInfos: targets };
        running = false;
        throw new Error('CDP WebSocket closed');
      });
    }),
  };
  return {
    root, state, sent, warn, dependencies,
    run: () => closeUnusedChrome(root, state, 'http://127.0.0.1:45123', dependencies),
    targets: (value: { type: string }[]) => { targets = value; },
    identity: (value: string) => { identity = value; },
    stopped: () => { running = false; },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('dedicated Chrome shutdown', () => {
  it('allows extension workers, tolerates disconnect on close, and clears the endpoint only after exit', async () => {
    const f = await helperFixture();
    await f.run();
    expect(f.sent).toEqual(['Target.getTargets', 'Browser.close']);
    expect(f.warn).not.toHaveBeenCalled();
    await expect(readFile(f.state)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(f.root, '.bu-dedicated-profile'), 'utf8')).toContain('managed-by=');
  });

  it('leaves a browser with an unowned page open', async () => {
    const f = await helperFixture();
    f.targets([{ type: 'page' }]);
    await f.run();
    expect(f.sent).not.toContain('Browser.close');
    expect(f.warn).toHaveBeenCalledWith('page tabs remain open');
    await expect(readFile(f.state)).resolves.toBeDefined();
  });

  it('waits for the ending session’s closing page to disappear', async () => {
    const f = await helperFixture();
    f.targets([{ type: 'page' }]);
    f.dependencies.delay = async () => { f.targets([]); };
    await f.run();
    expect(f.sent).toEqual(['Target.getTargets', 'Target.getTargets', 'Browser.close']);
  });

  it('does not close a replacement browser on a reused port', async () => {
    const f = await helperFixture();
    f.identity('ws://127.0.0.1:45123/devtools/browser/replacement');
    await f.run();
    expect(f.dependencies.cdpSession).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledWith('browser identity changed');
    await expect(readFile(f.state)).resolves.toBeDefined();
  });

  it('requires a managed profile and matching recorded profile', async () => {
    const f = await helperFixture();
    await rm(path.join(f.root, '.bu-dedicated-profile'));
    await f.run();
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
    await writeFile(path.join(f.root, '.bu-dedicated-profile'), 'managed-by=browser-use-skill\n');
    await writeFile(f.state, '45123\n/devtools/browser/test\n/another/profile\n');
    await f.run();
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
  });

  it('handles an already-stopped browser idempotently', async () => {
    const f = await helperFixture();
    f.stopped();
    await f.run();
    expect(f.dependencies.cdpSession).not.toHaveBeenCalled();
    await expect(readFile(f.state)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the endpoint record if shutdown does not actually stop Chrome', async () => {
    const f = await helperFixture();
    f.dependencies.cdpSession = vi.fn(async (_socket, callback) => {
      await callback(async (method) => {
        f.sent.push(method);
        return method === 'Target.getTargets' ? { targetInfos: [] } : {};
      });
    });
    await f.run();
    expect(f.warn).toHaveBeenCalledWith('browser did not exit');
    await expect(readFile(f.state)).resolves.toBeDefined();
  });

  it('does not interpret a failed or timed-out probe as proof that Chrome stopped', async () => {
    const f = await helperFixture();
    f.dependencies.fetch.mockRejectedValue(new Error('timeout'));
    await f.run();
    expect(f.warn).toHaveBeenCalledWith('timeout');
    await expect(readFile(f.state)).resolves.toBeDefined();
  });

  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])('retries %s while Chrome exits without a false warning', async (code) => {
    const f = await helperFixture();
    const probe = f.dependencies.fetch.getMockImplementation()!;
    f.dependencies.fetch.mockImplementationOnce(probe).mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { cause: { code } }));
    await f.run();
    expect(f.sent).toContain('Browser.close');
    expect(f.warn).not.toHaveBeenCalled();
    await expect(readFile(f.state)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function wrapperFixture() {
  const root = await temporaryRoot();
  const bin = path.join(root, 'bin');
  const profile = path.join(root, 'profile');
  const bh = path.join(root, 'bh');
  const runtime = path.join(root, 'runtime');
  const calls = path.join(root, 'shutdown-calls');
  const inventoryLog = path.join(root, 'inventory-calls');
  const config = path.join(root, 'bu.conf');
  await Promise.all([bin, profile, path.join(bh, 'sessions')].map((dir) => mkdir(dir, { recursive: true })));
  // cksum reads stdin, so close its input explicitly.
  const checksum = await new Promise<string>((resolve) => {
    const child = spawn('cksum');
    let out = '';
    child.stdout.on('data', (data) => { out += data; });
    child.on('close', () => resolve(out.trim().split(/\s+/).join('-')));
    child.stdin.end(profile);
  });
  const profileRuntime = path.join(runtime, `profile-${checksum}`);
  await mkdir(profileRuntime, { recursive: true });
  await writeFile(path.join(profileRuntime, 'DevToolsActivePort'), `45123\n/devtools/browser/test\n${profile}\n`);
  await writeFile(config, `browser_binary=${bin}/chrome\nprofile_dir=${profile}\n`);
  await executable(path.join(bin, 'chrome'), '#!/bin/sh\nexit 0\n');
  await executable(path.join(bin, 'curl'), `#!/bin/sh
case "$*" in
  */json/version*)
    if [ -n "\${TEST_CONNECT_STARTED:-}" ]; then
      touch "$TEST_CONNECT_STARTED"
      while [ ! -f "$TEST_CONNECT_RELEASE" ]; do sleep 0.02; done
    fi
    printf '{"webSocketDebuggerUrl":"ws://127.0.0.1:45123/devtools/browser/test"}';;
  *) printf 'Target is closing';;
esac
`);
  await executable(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  */close-unused-chrome.mjs) printf 'shutdown\\n' >> '${calls}';;
  */sweep-unassigned-tabs.mjs) printf '%s\\n' "$7" >> '${inventoryLog}';;
esac
`);
  await executable(path.join(bin, 'browser-use'), `#!/bin/sh
trap 'exit 130' INT
if [ "$*" = '--reload' ]; then exit 0; fi
if [ -n "\${TEST_PHASE_LOG:-}" ]; then printf 'command\\n' >> "$TEST_PHASE_LOG"; fi
if [ -n "\${TEST_STARTED:-}" ]; then
  touch "$TEST_STARTED"
  while [ ! -f "$TEST_RELEASE" ]; do sleep 0.02; done
fi
cat
exit "\${TEST_EXIT:-0}"
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BU_CONFIG_FILE: config, BU_RUNTIME_DIR: runtime, BH_HOME: bh, BU_SWEEP_SYNC: '1' };
  const seed = (id: string, store = bh) => writeFile(path.join(store, 'sessions', `${id}.lastuse`), '');
  const end = (id: string, overrides = {}, alias = '--end') => exec(wrapper, [id, alias], { env: { ...env, ...overrides } });
  const shutdowns = async () => readFile(calls, 'utf8').catch(() => '');
  const inventoryCalls = async () => readFile(inventoryLog, 'utf8').catch(() => '');
  return { root, bh, profileRuntime, env, seed, end, shutdowns, inventoryLog, inventoryCalls };
}

describe('final session coordination', () => {
  it('observes before browser code and expires afterward even when the command fails', async () => {
    const f = await wrapperFixture();
    const child = spawn(wrapper, ['failed'], { env: { ...f.env, TEST_EXIT: '9', TEST_PHASE_LOG: f.inventoryLog } });
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.end('raise RuntimeError()\n');
    expect(await done).toBe(9);
    expect(await f.inventoryCalls()).toBe('observe\ncommand\nsweep\n');
  });

  it('registers relative session stores with an absolute path for other callers', async () => {
    const f = await wrapperFixture();
    const child = spawn(wrapper, ['relative'], { cwd: f.root, env: { ...f.env, BH_HOME: 'bh' } });
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.end('print(1)\n');
    expect(await done).toBe(0);
    const directory = path.join(f.profileRuntime, 'session-stores');
    const records = await readdir(directory);
    expect(records).toHaveLength(1);
    expect(await readFile(path.join(directory, records[0]), 'utf8')).toBe(f.bh + '\n');
  });

  it('does not trigger unassigned expiry from read-only browser status', async () => {
    const f = await wrapperFixture();
    await exec(wrapper, ['chrome', 'status'], { env: f.env });
    expect(await f.inventoryCalls()).toBe('');
  });

  it('checks unassigned expiry during explicit session cleanup', async () => {
    const f = await wrapperFixture();
    await f.seed('last');
    await f.end('last');
    expect(await f.inventoryCalls()).toBe('sweep\nobserve\n');
  });

  it('keeps Chrome for another session, then closes it after the final --reload', async () => {
    const f = await wrapperFixture();
    await Promise.all([f.seed('first'), f.seed('second')]);
    await f.end('first');
    expect(await f.shutdowns()).toBe('');
    await f.end('second', {}, '--reload');
    expect(await f.shutdowns()).toBe('shutdown\n');
  });

  it('never shuts down an explicit CDP browser', async () => {
    const f = await wrapperFixture();
    await f.seed('external');
    await f.end('external', { BU_CDP_URL: 'http://127.0.0.1:45123' });
    expect(await f.shutdowns()).toBe('');
    expect(await f.inventoryCalls()).toBe('');
    expect(await readdir(path.join(f.bh, 'sessions'))).toEqual([]);
  });

  it('reclaims a dead lock owner and dead command marker before final cleanup', async () => {
    const f = await wrapperFixture();
    await f.seed('last');
    await symlink('999999999', path.join(f.profileRuntime, 'lifecycle.lock'));
    await mkdir(path.join(f.profileRuntime, 'calls'));
    await writeFile(path.join(f.profileRuntime, 'calls', '999999999'), 'gone\n');
    await f.end('last');
    expect(await f.shutdowns()).toBe('shutdown\n');
  });

  it('keeps Chrome for an in-flight passthrough command and preserves its exit code', async () => {
    const f = await wrapperFixture();
    const started = path.join(f.root, 'started');
    const release = path.join(f.root, 'release');
    const child = spawn(wrapper, ['passthrough', '--version'], {
      env: { ...f.env, TEST_STARTED: started, TEST_RELEASE: release, TEST_EXIT: '7' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.end();
    try {
      await vi.waitFor(async () => { await readFile(started); });
      await f.seed('last');
      await f.end('last');
      expect(await f.shutdowns()).toBe('');
      expect(await readdir(path.join(f.bh, 'sessions'))).toEqual([]);
    } finally {
      await writeFile(release, '');
      expect(await exited).toBe(7);
    }
    expect(await readdir(path.join(f.profileRuntime, 'calls'))).toEqual([]);
    expect(await f.shutdowns()).toBe('shutdown\n');
  });

  it('forgets deleted stores while respecting live sessions in another store', async () => {
    const f = await wrapperFixture();
    const stores = path.join(f.profileRuntime, 'session-stores');
    await mkdir(stores);
    await writeFile(path.join(stores, 'deleted'), `${f.root}/deleted-parent/deleted-bh\n`);
    const other = path.join(f.root, 'other-bh');
    await mkdir(path.join(other, 'sessions'), { recursive: true });
    await writeFile(path.join(stores, 'other'), `${other}\n`);
    await f.seed('other-live', other);
    await f.seed('first');
    await f.end('first');
    expect(await f.shutdowns()).toBe('');
    await rm(path.join(other, 'sessions', 'other-live.lastuse'));
    await f.end('first');
    expect(await f.shutdowns()).toBe('shutdown\n');
    expect(await readdir(stores)).not.toContain('deleted');
  });

  it('works without BASHPID, as on the macOS system Bash', async () => {
    const f = await wrapperFixture();
    const bashEnv = path.join(f.root, 'bash-env');
    await writeFile(bashEnv, 'unset BASHPID\n');
    const child = spawn(wrapper, ['portable'], { env: { ...f.env, BASH_ENV: bashEnv, BU_SWEEP_SYNC: '0' } });
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.end('print(1)\n');
    expect(await done).toBe(0);
    await f.end('portable', { BASH_ENV: bashEnv });
    expect(await f.shutdowns()).toBe('shutdown\n');
  });

  it('registers a new session before a concurrent final cleanup can close Chrome', async () => {
    const f = await wrapperFixture();
    await f.seed('old');
    const started = path.join(f.root, 'connecting');
    const release = path.join(f.root, 'connect-release');
    const child = spawn(wrapper, ['new'], { env: { ...f.env, TEST_CONNECT_STARTED: started, TEST_CONNECT_RELEASE: release } });
    const done = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.end('print(1)\n');
    try {
      await vi.waitFor(async () => { await readFile(started); });
      await expect(readFile(path.join(f.bh, 'sessions', 'new.lastuse'))).resolves.toBeDefined();
      const ending = f.end('old');
      await writeFile(release, '');
      await ending;
      expect(await done).toBe(0);
      expect(await f.shutdowns()).toBe('');
    } finally {
      await writeFile(release, '');
      await done;
    }
    await f.end('new');
    expect(await f.shutdowns()).toBe('shutdown\n');
  });

  it.each([['SIGTERM', 143], ['SIGINT', 130]] as const)('forwards %s and removes the in-flight marker', async (signal, status) => {
    const f = await wrapperFixture();
    const started = path.join(f.root, 'started');
    const release = path.join(f.root, 'release');
    const child = spawn(wrapper, ['passthrough', '--version'], {
      env: { ...f.env, TEST_STARTED: started, TEST_RELEASE: release },
    });
    let exitCode: number | null | undefined;
    const done = new Promise<number | null>((resolve) => child.on('close', (code) => { exitCode = code; resolve(code); }));
    child.stdin.end();
    try {
      await vi.waitFor(async () => { await readFile(started); });
      child.kill(signal);
      await vi.waitFor(() => expect(exitCode).toBe(status), { timeout: 1500 });
      expect(await readdir(path.join(f.profileRuntime, 'calls'))).toEqual([]);
    } finally {
      await writeFile(release, '');
      child.kill('SIGTERM');
      await done;
    }
  });

  it('cancels during startup without waiting for the CDP connection attempt', async () => {
    const f = await wrapperFixture();
    const started = path.join(f.root, 'connecting');
    const release = path.join(f.root, 'connect-release');
    const child = spawn(wrapper, ['canceled'], { env: { ...f.env, TEST_CONNECT_STARTED: started, TEST_CONNECT_RELEASE: release } });
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));
    child.stdin.end('print(1)\n');
    try {
      await vi.waitFor(async () => { await readFile(started); });
      child.kill('SIGTERM');
      await vi.waitFor(() => expect(child.signalCode).toBe('SIGTERM'), { timeout: 1000 });
      expect(await readdir(f.profileRuntime)).not.toContain('lifecycle.lock');
      expect(await readdir(path.join(f.profileRuntime, 'calls'))).toEqual([]);
    } finally {
      await writeFile(release, '');
      child.kill('SIGTERM');
      await closed;
    }
  });
});
