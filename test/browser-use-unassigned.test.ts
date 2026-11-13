import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Local JavaScript helper follows the skill's existing script convention.
import { sweepUnassignedTabs } from '../skills/browser-use/scripts/sweep-unassigned-tabs.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bu-unassigned-'));
  roots.push(root);
  const profile = path.join(root, 'profile');
  const runtime = path.join(root, 'runtime');
  const store = path.join(root, 'bh');
  await Promise.all([profile, runtime, path.join(store, 'sessions'), path.join(runtime, 'calls'), path.join(runtime, 'session-stores')].map((directory) => mkdir(directory, { recursive: true })));
  const state = path.join(runtime, 'DevToolsActivePort');
  const inventory = path.join(runtime, 'unassigned-tabs.json');
  await writeFile(path.join(profile, '.bu-dedicated-profile'), 'managed-by=browser-use-skill\n');
  await writeFile(state, `45123\n/devtools/browser/test\n${profile}\n`);
  let socket = 'ws://127.0.0.1:45123/devtools/browser/test';
  let time = 10_000_000;
  let targets = [{ type: 'page', targetId: 'pdf' }, { type: 'page', targetId: 'assigned' }, { type: 'service_worker', targetId: 'worker' }];
  await writeFile(path.join(store, 'sessions', 'owner.tabs'), 'assigned\n');
  const closed: string[] = [];
  const warn = vi.fn();
  const dependencies = {
    now: () => time,
    warn,
    processRunning: (pid: number) => pid === process.pid,
    fetch: vi.fn(async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: socket }) })),
    cdpSession: vi.fn(async (_socket: string, callback: (send: (method: string, params?: { targetId: string }) => Promise<unknown>) => Promise<void>) => {
      await callback(async (method, params) => {
        if (method === 'Target.getTargets') return { targetInfos: targets };
        if (method !== 'Target.closeTarget' || !params) throw new Error('unexpected CDP operation');
        closed.push(params.targetId);
        targets = targets.filter((target) => target.targetId !== params.targetId);
        return { success: true };
      });
    }),
  };
  return {
    root, profile, runtime, store, state, inventory, closed, warn, dependencies,
    read: async () => JSON.parse(await readFile(inventory, 'utf8')),
    run: (mode = 'sweep', ttl = '3600') => sweepUnassignedTabs(profile, state, 'http://127.0.0.1:45123', store, process.pid, mode, ttl, dependencies),
    advance: (ms: number) => { time += ms; },
    targets: (value: typeof targets) => { targets = value; },
    restart: async () => {
      socket = 'ws://127.0.0.1:45123/devtools/browser/restarted';
      await writeFile(state, `45123\n/devtools/browser/restarted\n${profile}\n`);
    },
  };
}

describe('unassigned tab expiry', () => {
  it('starts a clock when observed and closes only after a full TTL on a later sweep', async () => {
    const f = await fixture();
    await f.run('observe');
    expect((await f.read()).firstSeen).toEqual({ pdf: 10_000_000 });
    f.advance(3_599_999);
    await f.run();
    expect(f.closed).toEqual([]);
    f.advance(1);
    await f.run();
    expect(f.closed).toEqual(['pdf']);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it('observation alone never closes an old page or resets its clock', async () => {
    const f = await fixture();
    await f.run('observe');
    f.advance(7_200_000);
    await f.run('observe');
    expect(f.closed).toEqual([]);
    expect((await f.read()).firstSeen.pdf).toBe(10_000_000);
  });

  it('protects assignments across registered session stores', async () => {
    const f = await fixture();
    await f.run();
    f.advance(3_600_000);
    const other = path.join(f.root, 'other-bh');
    await mkdir(path.join(other, 'sessions'), { recursive: true });
    await writeFile(path.join(other, 'sessions', 'other.tabs'), 'pdf\n');
    await writeFile(path.join(f.runtime, 'session-stores', 'other'), other + '\n');
    await f.run();
    expect(f.closed).toEqual([]);
    expect((await f.read()).firstSeen).toEqual({});
  });

  it('defers closure while another command runs, but not for the current caller or a dead marker', async () => {
    const f = await fixture();
    await f.run();
    f.advance(3_600_000);
    await writeFile(path.join(f.runtime, 'calls', '1234567'), 'other\n');
    await writeFile(path.join(f.runtime, 'calls', String(process.pid)), 'caller\n');
    f.dependencies.processRunning = () => true;
    await f.run();
    expect(f.closed).toEqual([]);
    f.dependencies.processRunning = (pid) => pid === process.pid;
    await f.run();
    expect(f.closed).toEqual(['pdf']);
  });

  it('disables expiry at TTL zero while retaining observation', async () => {
    const f = await fixture();
    await f.run();
    f.advance(30_000_000);
    await f.run('sweep', '0');
    expect(f.closed).toEqual([]);
    expect((await f.read()).firstSeen.pdf).toBe(10_000_000);
  });

  it('uses the configured TTL and falls back to an hour for invalid values', async () => {
    const f = await fixture();
    await f.run();
    f.advance(10_000);
    await f.run('sweep', 'invalid');
    expect(f.closed).toEqual([]);
    await f.run('sweep', '10');
    expect(f.closed).toEqual(['pdf']);
  });

  it('resets saved ages when the browser identity changes', async () => {
    const f = await fixture();
    await f.run();
    f.advance(3_600_000);
    await f.restart();
    await f.run();
    expect(f.closed).toEqual([]);
    expect((await f.read()).firstSeen.pdf).toBe(13_600_000);
  });

  it('drops disappeared and newly assigned entries, and ignores extension workers', async () => {
    const f = await fixture();
    await f.run();
    f.targets([{ type: 'page', targetId: 'new' }, { type: 'service_worker', targetId: 'worker' }]);
    await f.run();
    expect((await f.read()).firstSeen).toEqual({ new: 10_000_000 });
    await writeFile(path.join(f.store, 'sessions', 'new.tabs'), 'new\n');
    await f.run();
    expect((await f.read()).firstSeen).toEqual({});
  });

  it('skips closure when an ownership record cannot be read', async () => {
    const f = await fixture();
    await f.run();
    f.advance(3_600_000);
    await mkdir(path.join(f.store, 'sessions', 'unreadable.tabs'));
    await f.run();
    expect(f.closed).toEqual([]);
    expect(f.warn).toHaveBeenCalled();
  });

  it('fails closed on older relative store registrations from an unknown working directory', async () => {
    const f = await fixture();
    await f.run();
    f.advance(3_600_000);
    await writeFile(path.join(f.runtime, 'session-stores', 'legacy'), 'bh\n');
    await f.run();
    expect(f.closed).toEqual([]);
    expect(f.warn).toHaveBeenCalledWith('registered session store has an ambiguous relative path');
  });

  it('handles removed temporary stores without losing other ownership', async () => {
    const f = await fixture();
    await writeFile(path.join(f.runtime, 'session-stores', 'gone'), `${f.root}/removed-parent/bh\n`);
    await f.run();
    f.advance(3_600_000);
    await f.run();
    expect(f.closed).toEqual(['pdf']);
  });

  it.each(['broken-json', 'null', '{"browser":"ws://127.0.0.1:45123/devtools/browser/test","firstSeen":{"pdf":-1}}'])('starts fresh clocks for invalid inventory: %s', async (contents) => {
    const f = await fixture();
    await writeFile(f.inventory, contents);
    await f.run();
    expect(f.closed).toEqual([]);
    expect((await f.read()).firstSeen.pdf).toBe(10_000_000);
    expect((await readdir(f.runtime)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('never connects to a mismatched browser or a profile without ownership', async () => {
    const f = await fixture();
    await writeFile(f.state, `45123\n/devtools/browser/wrong\n${f.profile}\n`);
    await f.run();
    expect(f.dependencies.cdpSession).not.toHaveBeenCalled();
    await writeFile(f.state, `45123\n/devtools/browser/test\n${f.profile}\n`);
    await rm(path.join(f.profile, '.bu-dedicated-profile'));
    await f.run();
    expect(f.dependencies.cdpSession).not.toHaveBeenCalled();
    expect(f.closed).toEqual([]);
  });
});
