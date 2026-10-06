// Runs inside the remote systemd unit, or as the local proxy's lease guardian.
// The caller owns stdin: EOF (including caller SIGKILL) revokes the lease.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = JSON.parse(Buffer.from(process.argv.at(-1), 'base64').toString());
process.umask(0o077);
let child;
let stopping = false;
let lastBeat = Date.now();
let setupComplete = false;
let setupOutput = '';
function signalChild(signal) {
  if (!child?.pid) return;
  try {
    if (config.mode === 'setup') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(lease);
  clearTimeout(expiry);
  const finish = () => {
    // The installer shell can exit before its descendants; revoke the whole
    // group before allowing the guardian to exit.
    if (config.mode === 'setup') signalChild('SIGKILL');
    // Only the retained setup guardian owns session files. A proxy guardian
    // may finish later, after the same session ID has already been restarted.
    if (config.mode === 'setup' && config.runtime && process.ppid !== config.supervisor) {
      fs.rmSync(config.runtime, { recursive: true, force: true });
      fs.rmSync(config.registry, { recursive: true, force: true });
    }
    process.exit(code);
  };
  if (!child || child.exitCode !== null || child.signalCode !== null) return finish();
  child.once('close', finish);
  signalChild('SIGTERM');
  setTimeout(() => signalChild('SIGKILL'), 2000).unref();
}

const lease = setInterval(() => {
  if (Date.now() - lastBeat > 15000) stop(1);
}, 1000);
let expiry = setTimeout(() => stop(config.mode === 'setup' ? 1 : 0), config.lifetime * 1000);
process.stdin.on('data', () => { lastBeat = Date.now(); });
process.stdin.on('end', () => stop(config.mode === 'setup' && !setupComplete ? 1 : 0));
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
process.on('SIGHUP', () => stop());

if (config.mode === 'remote') {
  const runtime = process.env.RUNTIME_DIRECTORY;
  if (!runtime || !process.env.WAYLAND_DISPLAY) {
    console.error('remote-view: a running Wayland desktop and systemd user manager are required');
    stop(1);
  } else {
    const socket = path.join(runtime, 'vnc.sock');
    child = spawn('wayvnc', ['-C', '/dev/null', '-R', '-e', '-f', '10',
      '-S', path.join(runtime, 'control.sock'), `unix:${socket}`],
    { stdio: ['ignore', 'ignore', 'inherit'] });
    // Do not connect to probe: -e would treat the probe as the human's session.
    const ready = setInterval(() => {
      if (!fs.existsSync(socket)) return;
      clearInterval(ready);
      fs.chmodSync(socket, 0o600);
      console.log(JSON.stringify({ socket, pid: child.pid }));
    }, 50);
    child.once('close', () => clearInterval(ready));
  }
} else if (config.mode === 'proxy' || config.mode === 'setup') {
  // --run-once keeps websockify in one process and stops after the viewer closes.
  // The independent guardian also bounds lifetime while a viewer is connected.
  child = spawn(config.command[0], config.command.slice(1), {
    detached: config.mode === 'setup',
    stdio: ['ignore', config.mode === 'setup' ? 'pipe' : 'ignore', 'inherit'],
  });
  if (config.mode === 'setup') child.stdout.on('data', (chunk) => { setupOutput += chunk; });
  else console.log(JSON.stringify({ pid: child.pid }));
} else {
  console.error('remote-view: invalid worker mode');
  stop(1);
}
if (child) {
  child.once('error', (error) => { console.error(error.message); stop(1); });
  child.once('close', (code, signal) => {
    if (stopping) return;
    if (config.mode === 'setup' && code === 0 && !signal) {
      signalChild('SIGKILL'); // remove any installer descendants before dropping ownership
      child = undefined;
      setupComplete = true;
      console.log(JSON.stringify({ dependencies: setupOutput.trim() }));
      if (config.retain) {
        // Keep this same guardian across remote startup, rather than leaving
        // an interval with nobody responsible for the local session files.
        clearTimeout(expiry);
        expiry = setTimeout(() => stop(), config.retain * 1000);
      } else stop();
    } else stop(code === 0 && !signal ? 0 : 1);
  });
}
