import { spawn, execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForExit(child, ms) {
  let timer;
  try {
    await Promise.race([child.closed, new Promise((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}
export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
const base = process.env.BU_VIEW_RUNTIME_DIR || path.join(os.tmpdir(), `bu-view-${process.getuid()}`);

export function parseArgs(argv) {
  const options = { command: argv[0], lifetime: 900, open: true };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--local') options.local = true;
    else if (key === '--no-open') options.open = false;
    else if (['--ssh', '--session', '--ssh-port', '--identity', '--ssh-config', '--lifetime'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key.slice(2)] = argv[++i];
    } else throw new Error(`Unknown option: ${key}`);
  }
  if (!['setup', 'start', 'status', 'stop'].includes(options.command)) {
    throw new Error('Usage: bu remote-view {setup|start|status|stop} [--session ID] [--ssh USER@HOST | --local] [--no-open] [--lifetime SECONDS]');
  }
  if (options.command !== 'setup' && !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,60}$/.test(options.session || '')) {
    throw new Error('A valid --session ID is required');
  }
  options.lifetime = Number(options.lifetime);
  if (!Number.isInteger(options.lifetime) || options.lifetime < 30 || options.lifetime > 3600) {
    throw new Error('--lifetime must be 30–3600 seconds');
  }
  if (options.command === 'start' && Boolean(options.local) === Boolean(options.ssh)) {
    throw new Error('Choose --ssh USER@HOST or --local');
  }
  if (options.ssh && !/^[A-Za-z0-9_][A-Za-z0-9_.@:[\]-]*$/.test(options.ssh)) throw new Error('Invalid SSH destination');
  if (options['ssh-port'] && (!/^\d+$/.test(options['ssh-port']) || Number(options['ssh-port']) < 1 || Number(options['ssh-port']) > 65535)) {
    throw new Error('Invalid SSH port');
  }
  return options;
}

async function privateBase() {
  await mkdir(base, { mode: 0o700, recursive: true });
  const info = await lstat(base);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error(`Runtime directory must be owned by you with mode 0700: ${base}`);
  }
}

async function setup(managed, ownership = {}) {
  const child = managed(process.execPath, [path.join(scripts, 'view-worker.cjs'), encode({
    mode: 'setup', lifetime: 180, command: ['bash', path.join(scripts, 'setup-remote-view.sh')], ...ownership,
  })], false);
  let output = '';
  let ready;
  const prepared = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const line = output.split('\n').find((value) => value.startsWith('{'));
      if (line) {
        try { ready = JSON.parse(line); resolve(ready.dependencies); } catch (error) { reject(error); }
      }
    });
    child.once('close', () => { if (!ready) reject(new Error('Dependency setup failed or was canceled')); });
  });
  if (ownership.retain) return await prepared;
  const dependencies = await prepared;
  await child.closed;
  if (child.exitCode !== 0) throw new Error('Dependency setup failed or was canceled');
  return dependencies;
}

export function remoteCommand(source, token, lifetime, nodeBinary = 'node') {
  const args = ['systemd-run', '--user', '--quiet', '--collect', '--wait', '--pipe', '--service-type=exec',
    '--expand-environment=no', `--unit=bu-view-${token}`, `--property=RuntimeMaxSec=${lifetime}s`,
    '--property=TimeoutStopSec=5s', '--property=KillMode=control-group', '--property=LimitCORE=0',
    '--property=UMask=0077', `--property=RuntimeDirectory=bu-view-${token}`, '--property=RuntimeDirectoryMode=0700',
    nodeBinary, '-e', source, encode({ mode: 'remote', lifetime })];
  return args;
}

function sshArgs(options, control) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3',
    '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no', '-o', `ControlPath=${control}`];
  if (options['ssh-port']) args.push('-p', options['ssh-port']);
  if (options.identity) args.push('-i', options.identity, '-o', 'IdentitiesOnly=yes');
  if (options['ssh-config']) args.push('-F', options['ssh-config']);
  return args;
}

async function socketRequest(socket, command) {
  return await new Promise((resolve, reject) => {
    const client = net.connect(socket);
    let response = '';
    client.setTimeout(3000, () => client.destroy(new Error('Viewer control timed out')));
    client.on('error', reject);
    client.on('connect', () => client.write(`${command}\n`));
    client.on('data', (chunk) => { response += chunk; });
    client.on('end', () => {
      try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
    });
  });
}

async function control(options) {
  const registry = path.join(base, options.session);
  let state;
  try { state = JSON.parse(await readFile(path.join(registry, 'state.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return console.log(JSON.stringify({ session: options.session, status: 'stopped' }));
    throw error;
  }
  try {
    const response = await socketRequest(state.control, options.command);
    if (options.command === 'stop') {
      for (let i = 0; i < 120; i++) {
        try { await lstat(registry); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (i === 119) throw new Error('Stop requested but cleanup has not finished; check status again');
        await sleep(100);
      }
    }
    console.log(JSON.stringify(response));
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    // Do not signal a saved PID: it may have been reused. Workers self-expire.
    console.log(JSON.stringify({ ...state, status: 'unreachable',
      message: 'Supervisor unavailable; workers revoke the heartbeat lease within 15s. Inspect recorded resources before removing stale state.' }));
    process.exitCode = 1;
  }
}

async function start(options) {
  const registry = path.join(base, options.session);
  await mkdir(registry, { mode: 0o700 }); // exclusive: never overwrite a running session
  let runtime, server, heartbeat, startupTimer, expiry;
  const children = [];
  let reason;
  let stopped = false;
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const stop = (error) => { if (stopped) return; stopped = true; reason = error; finish(); };
  const check = () => { if (stopped) throw reason || new Error('Viewer stopped during startup'); };
  const state = { session: options.session, status: 'starting', supervisor: process.pid, ssh: options.ssh || null };
  const save = async () => {
    await writeFile(path.join(registry, 'state.tmp'), `${JSON.stringify(state)}\n`, { mode: 0o600 });
    await rename(path.join(registry, 'state.tmp'), path.join(registry, 'state.json'));
  };
  const managed = (command, args, persistent = true) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    child.closed = new Promise((resolve) => child.once('close', resolve));
    child.once('error', stop);
    child.once('exit', (code, signal) => {
      if (persistent || code !== 0 || signal) stop(code === 0 && !signal ? undefined : new Error(`${command} exited (${signal || code})`));
    });
    child.stdin.on('error', stop);
    children.push(child);
    if (!persistent) state.leaseGuardianPid = child.pid;
    return child;
  };
  const readyLine = async (child) => {
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    for (let i = 0; i < 300; i++) {
      check();
      const line = output.split('\n').find((value) => value.startsWith('{'));
      if (line) return JSON.parse(line);
      await sleep(100);
    }
    throw new Error('Worker readiness timed out');
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = () => stop();
  signals.forEach((signal) => process.on(signal, onSignal));
  try {
    runtime = await mkdtemp(path.join(os.tmpdir(), 'buv-'));
    await chmod(runtime, 0o700);
    state.runtime = runtime;
    state.control = path.join(runtime, 'ctl');
    server = net.createServer((client) => {
      client.setTimeout(3000, () => client.destroy());
      client.once('error', () => {});
      client.once('data', (data) => {
        const command = data.toString().trim();
        client.end(JSON.stringify(command === 'stop' ? { session: options.session, status: 'stopped' } : state));
        if (command === 'stop') stop();
      });
    });
    server.on('error', stop);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(state.control, resolve); });
    await chmod(state.control, 0o600);
    await save();
    heartbeat = setInterval(() => {
      for (const child of children) if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write('lease\n');
    }, 3000);
    const cancelSetup = () => {
      if (state.status === 'starting') for (const child of children) child.stdin.end();
    };
    done.then(cancelSetup);
    const dependencies = await setup(managed, { runtime, registry, supervisor: process.pid, retain: options.lifetime + 45 });
    check();
    startupTimer = setTimeout(() => stop(new Error('Viewer startup timed out')), 45000);
    expiry = setTimeout(() => stop(), options.lifetime * 1000);
    const source = await readFile(path.join(scripts, 'view-worker.cjs'), 'utf8');
    const token = randomBytes(8).toString('hex');
    state.unit = `bu-view-${token}.service`;
    state.expires = new Date(Date.now() + options.lifetime * 1000).toISOString();
    await save();
    const masterSocket = path.join(runtime, 'ssh');
    const remoteArgs = remoteCommand(source, token, options.lifetime, options.local ? process.execPath : 'node');
    // Remote shells need an absolute Node path for systemd. Never interpolate a
    // destination, identity, or source without proper shell quoting.
    const remoteShell = `export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; exec ${remoteArgs.slice(0, -4).map(shellQuote).join(' ')} "$(command -v node)" ${remoteArgs.slice(-3).map(shellQuote).join(' ')}`;
    const remote = options.local
      ? managed(remoteArgs[0], remoteArgs.slice(1))
      : managed('ssh', [...sshArgs(options, masterSocket), '--', options.ssh, remoteShell]);
    state.transportPid = remote.pid;
    await save();
    const ready = await readyLine(remote);
    state.vncPid = ready.pid;
    state.remoteSocket = ready.socket;
    await save();
    let target = ready.socket;
    if (!options.local) {
      target = path.join(runtime, 'vnc');
      await run('ssh', ['-S', masterSocket, '-O', 'forward', '-o', 'ExitOnForwardFailure=yes',
        '-L', `${target}:${ready.socket}`, '--', options.ssh], { timeout: 10000 });
      await chmod(target, 0o600);
    }
    check();
    const portServer = net.createServer();
    await new Promise((resolve, reject) => {
      portServer.once('error', reject);
      portServer.listen(0, '127.0.0.1', resolve);
    });
    state.port = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const capability = randomBytes(32).toString('hex');
    const tokenFile = path.join(runtime, 'tokens');
    await writeFile(tokenFile, `${capability}: unix_socket:${target}\n`, { mode: 0o600 });
    const origin = `http://127.0.0.1:${state.port}`;
    // Fragment keeps the capability out of HTTP asset requests/referrers.
    state.url = `${origin}/vnc.html?autoconnect=true&resize=scale&reconnect=false#path=${encodeURIComponent(`websockify?token=${capability}`)}`;
    const command = [path.join(dependencies, 'venv/bin/websockify'), '--run-once', '--web', path.join(dependencies, 'novnc'),
      '--file-only', '--token-plugin', 'TokenFile', '--token-source', tokenFile,
      '--auth-plugin', 'ExpectOrigin', '--auth-source', origin,
      '--timeout', String(options.lifetime), '--idle-timeout', '90', `127.0.0.1:${state.port}`];
    const proxy = managed(process.execPath, [path.join(scripts, 'view-worker.cjs'), encode({
      mode: 'proxy', command, lifetime: options.lifetime, runtime, registry, supervisor: process.pid,
    })]);
    state.guardianPid = proxy.pid;
    await save();
    state.proxyPid = (await readyLine(proxy)).pid;
    for (let i = 0; i < 100; i++) {
      check();
      try {
        const response = await fetch(`http://127.0.0.1:${state.port}/vnc.html`, { signal: AbortSignal.timeout(500) });
        await response.arrayBuffer();
        if (response.ok) break;
      } catch { /* proxy may still be starting */ }
      if (i === 99) throw new Error('Local viewer failed to start');
      await sleep(100);
    }
    clearTimeout(startupTimer);
    state.status = 'ready';
    await save();
    console.log(JSON.stringify(state));
    if (options.open) {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      await run(opener, [state.url], { timeout: 10000 }).catch(() => {
        console.error(`remote-view: open this URL in your normal local browser: ${state.url}`);
      });
    }
    await done;
    if (reason) throw reason;
  } finally {
    clearInterval(heartbeat);
    clearTimeout(startupTimer);
    clearTimeout(expiry);
    for (const child of children.toReversed()) {
      child.stdin.end();
      await waitForExit(child, 5500);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await waitForExit(child, 2000);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await waitForExit(child, 2000);
        }
      }
    }
    server?.close();
    if (runtime) await rm(runtime, { recursive: true, force: true });
    await rm(registry, { recursive: true, force: true });
    signals.forEach((signal) => process.removeListener(signal, onSignal));
  }
}

async function main() {
  process.umask(0o077);
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'setup') {
    let child;
    const onSignal = () => child?.stdin.end();
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const beat = setInterval(() => {
      if (child && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write('lease\n');
    }, 3000);
    try {
      const dependencies = await setup((command, args) => {
        child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
        child.closed = new Promise((resolve) => child.once('close', resolve));
        child.on('error', (error) => { console.error(error.message); });
        child.stdin.on('error', () => {});
        return child;
      });
      console.log(JSON.stringify({ dependencies }));
    } finally {
      clearInterval(beat);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
    return;
  }
  await privateBase();
  if (options.command === 'start') await start(options);
  else await control(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`remote-view: ${error.message}`); process.exitCode = 1; });
}
