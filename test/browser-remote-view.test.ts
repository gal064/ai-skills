import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, remoteCommand, shellQuote } from '../skills/browser-use/scripts/remote-view.mjs';

const run = promisify(execFile);
const wrapper = path.resolve('skills/browser-use/bin/bu');
const roots: string[] = [];
const running: ChildProcess[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(check: () => Promise<T>, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await pause(50);
  }
}

async function executable(file: string, content: string) {
  await writeFile(file, content);
  await chmod(file, 0o700);
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bu-view-test-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const remote = path.join(root, 'remote');
  const dependencies = path.join(root, 'cache/novnc-1.7.0-websockify-0.13.0');
  await Promise.all([mkdir(bin), mkdir(remote), mkdir(path.join(dependencies, 'venv/bin'), { recursive: true }),
    mkdir(path.join(dependencies, 'novnc'), { recursive: true })]);
  await writeFile(path.join(dependencies, 'ready'), '');
  await writeFile(path.join(dependencies, 'novnc/vnc.html'), 'test viewer');
  // Substitute desktop capture and systemd, keeping the real CLI, guardian,
  // control socket, HTTP listener, process ownership and cancellation flow.
  await executable(path.join(bin, 'systemd-run'), `#!${process.execPath}
const {spawn}=require('node:child_process');
const args=process.argv.slice(2), index=args.findIndex(a=>!a.startsWith('--'));
const child=spawn(args[index],args.slice(index+1),{stdio:'inherit',env:{...process.env,RUNTIME_DIRECTORY:process.env.TEST_REMOTE,WAYLAND_DISPLAY:'test'}});
child.on('exit',code=>process.exit(code||0));
`);
  await executable(path.join(bin, 'wayvnc'), `#!${process.execPath}
const fs=require('node:fs'),net=require('node:net');
const socket=process.argv.at(-1).slice(5),server=net.createServer();
server.listen(socket);
process.on('SIGTERM',()=>server.close(()=>{try{fs.unlinkSync(socket)}catch{};process.exit(0)}));
`);
  await executable(path.join(dependencies, 'venv/bin/websockify'), `#!${process.execPath}
const http=require('node:http');
const port=Number(process.argv.at(-1).split(':').at(-1));
http.createServer((req,res)=>res.end('test viewer')).listen(port,'127.0.0.1');
`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BU_VIEW_CACHE_DIR: path.join(root, 'cache'),
    BU_VIEW_RUNTIME_DIR: path.join(root, 'registry'), TEST_REMOTE: remote };
  return { root, env, remote };
}

async function start(env: NodeJS.ProcessEnv, session = 'test_login') {
  const child = spawn(wrapper, ['remote-view', 'start', '--local', '--session', session, '--no-open', '--lifetime', '30'], { env });
  running.push(child);
  let output = '', errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const state = await until(async () => {
    if (child.exitCode !== null) throw new Error(`start exited: ${errors}`);
    const line = output.split('\n').find((value) => value.startsWith('{'));
    return line ? JSON.parse(line) : undefined;
  });
  return { child, state };
}

async function absent(file: string) {
  try { await lstat(file); return false; } catch (error: any) { if (error.code === 'ENOENT') return true; throw error; }
}

async function portClosed(port: number) {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => resolve(true));
    socket.on('connect', () => { socket.destroy(); resolve(false); });
  });
}

afterEach(async () => {
  for (const child of running.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await pause(300);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('on-demand remote viewer', () => {
  it('rejects unsafe destinations and ambiguous launch targets before starting anything', () => {
    expect(() => parseArgs(['start', '--session', '../other', '--local'])).toThrow();
    expect(() => parseArgs(['start', '--session', 'valid', '--ssh', '-oProxyCommand=bad'])).toThrow();
    expect(() => parseArgs(['start', '--session', 'valid', '--ssh', 'user@host', '--local'])).toThrow();
    expect(() => parseArgs(['start', '--session', 'valid', '--local', '--lifetime', '0'])).toThrow();
  });

  it('preserves literal shell content when transporting the remote worker', async () => {
    const value = "'$HOME `printf unsafe` $(printf unsafe)\nline";
    const result = await run('sh', ['-c', `printf %s ${shellQuote(value)}`]);
    expect(result.stdout).toBe(value);
    const args = remoteCommand('worker', '0123456789abcdef', 30);
    expect(args).toContain('--property=KillMode=control-group');
    expect(args).toContain('--property=RuntimeDirectoryMode=0700');
    expect(args).toContain('--expand-environment=no');
  });

  it('owns a loopback-only viewer and exclusive session; stop removes all owned resources', async () => {
    const { env, remote } = await fixture();
    const { child, state } = await start(env);
    expect(state.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/vnc.html/);
    expect((await lstat(state.runtime)).mode & 0o777).toBe(0o700);
    expect((await lstat(state.remoteSocket)).mode & 0o777).toBe(0o600);
    const status = JSON.parse((await run(wrapper, ['remote-view', 'status', '--session', 'test_login'], { env })).stdout);
    expect(status.status).toBe('ready');
    await expect(run(wrapper, ['remote-view', 'start', '--local', '--session', 'test_login', '--no-open'], { env })).rejects.toThrow();
    await run(wrapper, ['remote-view', 'stop', '--session', 'test_login'], { env });
    expect(await portClosed(state.port)).toBe(true);
    expect(await absent(state.runtime)).toBe(true);
    expect(await absent(path.join(remote, 'vnc.sock'))).toBe(true);
    await until(async () => child.exitCode !== null);
    const stopped = JSON.parse((await run(wrapper, ['remote-view', 'status', '--session', 'test_login'], { env })).stdout);
    expect(stopped.status).toBe('stopped');
  }, 20000);

  it('revokes worker leases and removes the port and state after supervisor SIGKILL', async () => {
    const { env, remote } = await fixture();
    const { child, state } = await start(env);
    child.kill('SIGKILL');
    await until(async () => await portClosed(state.port));
    await until(async () => await absent(state.runtime));
    await until(async () => await absent(path.join(env.BU_VIEW_RUNTIME_DIR!, 'test_login')));
    await until(async () => await absent(path.join(remote, 'vnc.sock')));
  }, 20000);

  it('cleans startup state when remote capture cannot start', async () => {
    const { env, root } = await fixture();
    await executable(path.join(root, 'bin/wayvnc'), '#!/bin/sh\nexit 2\n');
    await expect(run(wrapper, ['remote-view', 'start', '--local', '--session', 'broken', '--no-open'], { env })).rejects.toThrow();
    expect(await absent(path.join(env.BU_VIEW_RUNTIME_DIR!, 'broken'))).toBe(true);
  }, 20000);

  it.each(['SIGTERM', 'SIGKILL'] as const)('cancels first-time setup and its descendants on %s', async (signal) => {
    const { env, root } = await fixture();
    await rm(path.join(root, 'cache'), { recursive: true });
    await executable(path.join(root, 'bin/curl'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.TEST_CURL_PID, String(process.pid));
setInterval(()=>{},1000);
`);
    const pidFile = path.join(root, 'curl.pid');
    const child = spawn(wrapper, ['remote-view', 'start', '--local', '--session', 'installing', '--no-open'], {
      env: { ...env, TEST_CURL_PID: pidFile }, stdio: 'ignore',
    });
    running.push(child);
    const curlPid = await until(async () => {
      try { return Number(await readFile(pidFile, 'utf8')); } catch { return undefined; }
    });
    const registry = path.join(env.BU_VIEW_RUNTIME_DIR!, 'installing');
    const state = JSON.parse(await readFile(path.join(registry, 'state.json'), 'utf8'));
    child.kill(signal);
    await until(async () => {
      try { process.kill(curlPid, 0); return false; } catch { return true; }
    });
    await until(async () => await absent(registry));
    await until(async () => await absent(state.runtime));
    expect(await absent(path.join(root, 'cache/setup.lock'))).toBe(true);
  }, 20000);

  it('keeps cleanup ownership while waiting for remote startup', async () => {
    const { env, root } = await fixture();
    const capturePidFile = path.join(root, 'capture.pid');
    await executable(path.join(root, 'bin/wayvnc'), `#!${process.execPath}
require('node:fs').writeFileSync(process.env.TEST_CAPTURE_PID, String(process.pid));
setInterval(()=>{},1000);
`);
    const child = spawn(wrapper, ['remote-view', 'start', '--local', '--session', 'starting', '--no-open'], {
      env: { ...env, TEST_CAPTURE_PID: capturePidFile }, stdio: 'ignore',
    });
    running.push(child);
    await until(async () => !(await absent(capturePidFile)));
    const registry = path.join(env.BU_VIEW_RUNTIME_DIR!, 'starting');
    const state = JSON.parse(await readFile(path.join(registry, 'state.json'), 'utf8'));
    expect(state.unit).toMatch(/^bu-view-[a-f0-9]+\.service$/);
    expect(state.transportPid).toBeGreaterThan(0);
    child.kill('SIGKILL');
    await until(async () => await absent(registry));
    await until(async () => await absent(state.runtime));
  }, 20000);

  it('keeps a restarted session controllable while its old proxy is still stopping', async () => {
    const { env, root, remote } = await fixture();
    await executable(path.join(root, 'cache/novnc-1.7.0-websockify-0.13.0/venv/bin/websockify'), `#!${process.execPath}
const http=require('node:http');
http.createServer((req,res)=>res.end('test viewer')).listen(Number(process.argv.at(-1).split(':').at(-1)),'127.0.0.1');
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),1500));
`);
    const first = await start(env);
    first.child.kill('SIGKILL');
    await until(async () => await absent(path.join(env.BU_VIEW_RUNTIME_DIR!, 'test_login')));
    await until(async () => await absent(path.join(remote, 'vnc.sock')));
    const second = await start(env);
    await until(async () => {
      try { process.kill(first.state.guardianPid, 0); return false; } catch { return true; }
    });
    const status = JSON.parse((await run(wrapper, ['remote-view', 'status', '--session', 'test_login'], { env })).stdout);
    expect(status.supervisor).toBe(second.child.pid);
    expect(status.status).toBe('ready');
    await run(wrapper, ['remote-view', 'stop', '--session', 'test_login'], { env });
    expect(await portClosed(second.state.port)).toBe(true);
    expect(await portClosed(first.state.port)).toBe(true);
  }, 20000);
});
