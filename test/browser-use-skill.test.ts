import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const skillDir = path.join(repositoryRoot, 'skills', 'browser-use');
const wrapper = path.join(skillDir, 'bin', 'bu');
const installer = path.join(skillDir, 'scripts', 'install.sh');
const temporaryDirectories: string[] = [];

async function temporaryRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function writeExecutable(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  await chmod(target, 0o700);
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return await execFileAsync(command, args, { env: { ...process.env, BU_BROWSER_LAUNCH_MODE: 'direct', ...env }, maxBuffer: 2_000_000 });
}

async function runWithInput(command: string, args: string[], input: string, env: NodeJS.ProcessEnv) {
  return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, BU_BROWSER_LAUNCH_MODE: 'direct', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end(input);
  });
}

async function readTree(root: string): Promise<string> {
  let content = '';
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) content += await readTree(target);
    else content += await readFile(target, 'utf8');
  }
  return content;
}

async function profileRuntimeDirectory(runtimeBase: string, profileDir: string) {
  const result = await runWithInput('cksum', [], profileDir, {});
  if (result.code !== 0) throw new Error(`cksum failed: ${result.stderr}`);
  const [checksum, length] = result.stdout.trim().split(/\s+/);
  return path.join(runtimeBase, `profile-${checksum}-${length}`);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('portable browser-use skill', () => {
  it('contains no machine-specific path or fixed CDP port and gates install instructions', async () => {
    const content = await readTree(skillDir);
    expect(content).not.toContain('/home/gal');
    expect(content).not.toMatch(/(?:127\.0\.0\.1:|remote-debugging-port=)9222/);
    const skill = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    expect(skill).toContain('If, and only if, the user explicitly asks to install or reinstall');
    expect(skill).toContain('read `install.md` completely');
    expect(skill).toContain('When running `bu` from Codex, execute every `bu` command with host permissions (`sandbox_permissions="require_escalated"`). `bu` requires access to files outside the sandbox.');
  });

  it('resolves the skill directory through an arbitrary wrapper symlink', async () => {
    const root = await temporaryRoot('bu-link-');
    const linkedWrapper = path.join(root, 'custom-bin', 'bu');
    await mkdir(path.dirname(linkedWrapper), { recursive: true });
    await symlink(wrapper, linkedWrapper);
    const { stdout } = await run(linkedWrapper, ['skill-dir'], {});
    expect(stdout.trim()).toBe(await realpath(skillDir));
  });

  it('installs idempotently, replaces only the upstream alias, and writes owner-only config', async () => {
    const root = await temporaryRoot('bu-install-');
    const toolBin = path.join(root, 'tool', 'bin');
    const installBin = path.join(root, 'installed-bin');
    const configFile = path.join(root, 'config with spaces', 'bu.conf');
    const profileDir = path.join(root, 'profile with spaces');
    const browser = path.join(root, 'browser with spaces');
    await writeExecutable(path.join(toolBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(toolBin, 'bu'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(browser, '#!/bin/sh\nexit 0\n');
    await mkdir(installBin, { recursive: true });
    await symlink(path.join(toolBin, 'bu'), path.join(installBin, 'bu'));
    const env = { PATH: `${toolBin}:${process.env.PATH}` };
    const args = [installer, '--browser', browser, '--profile-dir', profileDir, '--bin-dir', installBin, '--config-file', configFile, '--skip-start'];

    await run('bash', args, env);
    await run('bash', args, env);

    expect(await realpath(path.join(installBin, 'bu'))).toBe(await realpath(wrapper));
    expect(await readFile(configFile, 'utf8')).toContain(`browser_binary=${browser}`);
    expect(await readFile(configFile, 'utf8')).toContain(`profile_dir=${profileDir}`);
    expect((await lstat(configFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(profileDir, '.bu-dedicated-profile'), 'utf8')).toContain('managed-by=browser-use-skill');
  });

  it('recognizes a regular upstream bu console launcher only when it matches browser-use', async () => {
    const root = await temporaryRoot('bu-regular-upstream-');
    const toolBin = path.join(root, 'tool-bin');
    const browser = path.join(root, 'browser');
    await writeExecutable(path.join(toolBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(toolBin, 'bu'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(browser, '#!/bin/sh\nexit 0\n');

    await run('bash', [installer, '--browser', browser, '--profile-dir', path.join(root, 'profile'), '--config-file', path.join(root, 'bu.conf'), '--skip-start'], {
      PATH: `${toolBin}:${process.env.PATH}`,
    });

    expect(await realpath(path.join(toolBin, 'bu'))).toBe(await realpath(wrapper));
  });

  it('refuses a distinct same-directory bu executable as unrelated', async () => {
    const root = await temporaryRoot('bu-same-bin-collision-');
    const toolBin = path.join(root, 'tool-bin');
    const browser = path.join(root, 'browser');
    const existingBu = path.join(toolBin, 'bu');
    await writeExecutable(path.join(toolBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(existingBu, '#!/bin/sh\n# user-owned command\nexit 7\n');
    await writeExecutable(browser, '#!/bin/sh\nexit 0\n');

    await expect(run('bash', [installer, '--browser', browser, '--profile-dir', path.join(root, 'profile'), '--config-file', path.join(root, 'bu.conf'), '--skip-start'], {
      PATH: `${toolBin}:${process.env.PATH}`,
    })).rejects.toMatchObject({ stderr: expect.stringContaining('refusing to replace unrelated path') });
    expect(await readFile(existingBu, 'utf8')).toContain('user-owned command');
  });

  it('refuses unrelated bu paths unless replacement is explicitly confirmed and backed up', async () => {
    const root = await temporaryRoot('bu-collision-');
    const toolBin = path.join(root, 'tool-bin');
    const installBin = path.join(root, 'install-bin');
    const browser = path.join(root, 'browser');
    await writeExecutable(path.join(toolBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(browser, '#!/bin/sh\nexit 0\n');
    await mkdir(installBin, { recursive: true });
    await writeFile(path.join(installBin, 'bu'), 'user command\n');
    const baseArgs = [installer, '--browser', browser, '--profile-dir', path.join(root, 'profile'), '--bin-dir', installBin, '--config-file', path.join(root, 'bu.conf'), '--skip-start'];
    const env = { PATH: `${toolBin}:${process.env.PATH}` };

    await expect(run('bash', baseArgs, env)).rejects.toMatchObject({ stderr: expect.stringContaining('refusing to replace unrelated path') });
    await run('bash', [...baseArgs, '--replace-bu'], env);

    expect(await readFile(path.join(installBin, 'bu.bak'), 'utf8')).toBe('user command\n');
    expect(await realpath(path.join(installBin, 'bu'))).toBe(await realpath(wrapper));
  });

  it('preflights unrelated config before changing the profile or bu launcher, then backs it up when confirmed', async () => {
    const root = await temporaryRoot('bu-config-collision-');
    const toolBin = path.join(root, 'tool-bin');
    const installBin = path.join(root, 'install-bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'config', 'bu.conf');
    const browser = path.join(root, 'browser');
    await writeExecutable(path.join(toolBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await symlink(path.join(toolBin, 'browser-use'), path.join(toolBin, 'bu'));
    await writeExecutable(browser, '#!/bin/sh\nexit 0\n');
    await mkdir(installBin, { recursive: true });
    await symlink(path.join(toolBin, 'bu'), path.join(installBin, 'bu'));
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, 'user-owned-config=true\n');
    const env = { PATH: `${toolBin}:${process.env.PATH}` };
    const args = [installer, '--browser', browser, '--profile-dir', profileDir, '--bin-dir', installBin, '--config-file', configFile, '--skip-start'];

    await expect(run('bash', args, env)).rejects.toMatchObject({ stderr: expect.stringContaining('refusing to replace unrelated config') });
    expect(await realpath(path.join(installBin, 'bu'))).toBe(await realpath(path.join(toolBin, 'bu')));
    await expect(readFile(path.join(profileDir, '.bu-dedicated-profile'), 'utf8')).rejects.toThrow();

    await run('bash', [...args, '--replace-config'], env);
    expect(await readFile(`${configFile}.bak`, 'utf8')).toBe('user-owned-config=true\n');
    expect(await realpath(path.join(installBin, 'bu'))).toBe(await realpath(wrapper));
  });

  it('rejects everyday Chrome roots and their internal profile directories', async () => {
    const root = await temporaryRoot('bu-profile-boundary-');
    const home = path.join(root, 'home');
    const toolBin = path.join(root, 'tool-bin');
    const browser = path.join(root, 'browser');
    const everydayProfile = path.join(home, '.config', 'google-chrome', 'Default');
    await writeExecutable(path.join(toolBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(browser, '#!/bin/sh\nexit 0\n');
    await mkdir(everydayProfile, { recursive: true });

    await expect(run('bash', [installer, '--browser', browser, '--profile-dir', everydayProfile, '--bin-dir', path.join(root, 'install-bin'), '--config-file', path.join(root, 'bu.conf'), '--skip-start'], {
      PATH: `${toolBin}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
    })).rejects.toMatchObject({ stderr: expect.stringContaining('refusing everyday Chrome profile path') });
  });

  it('rejects everyday Chrome roots reached through a symlinked standard root', async () => {
    const root = await temporaryRoot('bu-profile-symlink-boundary-');
    const home = path.join(root, 'home');
    const toolBin = path.join(root, 'tool-bin');
    const browser = path.join(root, 'browser');
    const physicalChromeRoot = path.join(root, 'physical-chrome-root');
    const everydayProfile = path.join(physicalChromeRoot, 'Default');
    const standardRoot = path.join(home, '.config', 'google-chrome');
    await writeExecutable(path.join(toolBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(browser, '#!/bin/sh\nexit 0\n');
    await mkdir(everydayProfile, { recursive: true });
    await mkdir(path.dirname(standardRoot), { recursive: true });
    await symlink(physicalChromeRoot, standardRoot);

    await expect(run('bash', [installer, '--browser', browser, '--profile-dir', path.join(standardRoot, 'Default'), '--bin-dir', path.join(root, 'install-bin'), '--config-file', path.join(root, 'bu.conf'), '--skip-start'], {
      PATH: `${toolBin}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
    })).rejects.toMatchObject({ stderr: expect.stringContaining('refusing everyday Chrome profile path') });
  });

  it('auto-starts once under concurrency and reads Chrome-selected DevToolsActivePort', async () => {
    const root = await temporaryRoot('bu-start-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const runtimeDir = path.join(root, 'runtime');
    const invocationLog = path.join(root, 'chrome-invocations');
    const configFile = path.join(root, 'bu.conf');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'curl'), `#!/bin/sh
case "$*" in
  *39999*) printf '%s\\n' '{"webSocketDebuggerUrl":"ws://127.0.0.1:39999/devtools/browser/not-the-configured-profile"}'; exit 0;;
esac
url=""
for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done
port="\${url#http://127.0.0.1:}"; port="\${port%%/*}"
test -n "$port" || exit 1
printf '{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/test"}\\n' "$port"
`);
    await writeExecutable(fakeBrowser, `#!/usr/bin/env bash
set -eu
profile=""
for argument in "$@"; do
  case "$argument" in --user-data-dir=*) profile="\${argument#*=}";; esac
done
printf '%s\\n' "$*" >> "$FAKE_CHROME_LOG"
`);
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);
    await mkdir(profileDir, { recursive: true });
    await writeFile(path.join(profileDir, 'DevToolsActivePort'), '39999\n/devtools/browser/stale\n');
    const env = {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: runtimeDir,
      FAKE_CHROME_LOG: invocationLog,
    };

    const results = await Promise.all([run(wrapper, ['chrome', 'start'], env), run(wrapper, ['chrome', 'start'], env)]);

    const endpoints = results.map(({ stdout }) => stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]);
    expect(endpoints[0]).toBeTruthy();
    expect(endpoints[1]).toBe(endpoints[0]);
    const invocations = (await readFile(invocationLog, 'utf8')).trim().split('\n');
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatch(/--remote-debugging-port=[1-9]\d*/);
    expect(invocations[0]).not.toContain('--remote-debugging-port=0');
    expect(invocations[0]).toContain(`--user-data-dir=${profileDir}`);
    const runtimeEntries = await readdir(runtimeDir);
    const profileRuntime = runtimeEntries.find((entry) => entry.startsWith('profile-'));
    expect(profileRuntime).toBeTruthy();
    const chromeLog = await readFile(path.join(runtimeDir, profileRuntime!, 'chrome.log'), 'utf8');
    expect(chromeLog).not.toContain('9222');
  });

  it('launches Chrome through the Linux systemd user manager when available', async () => {
    const root = await temporaryRoot('bu-systemd-launch-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const invocationLog = path.join(root, 'systemd-run-invocation');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await writeExecutable(path.join(fakeBin, 'systemctl'), '#!/bin/sh\ncase "$*" in *show-environment*) exit 0;; *MainPID*) printf "%s\\n" "$PPID"; exit 0;; esac\nexit 1\n');
    await writeExecutable(path.join(fakeBin, 'systemd-run'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_SYSTEMD_RUN_LOG"\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/systemd"}\\n\' "$port"\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nexit 0\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    const { stdout } = await run(wrapper, ['chrome', 'start'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_BROWSER_LAUNCH_MODE: 'systemd',
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: path.join(root, 'runtime'),
      FAKE_SYSTEMD_RUN_LOG: invocationLog,
    });

    const invocation = await readFile(invocationLog, 'utf8');
    expect(stdout).toMatch(/http:\/\/127\.0\.0\.1:[1-9]\d*/);
    expect(invocation).toContain('--user --quiet --collect --service-type=exec');
    expect(invocation).toContain('--unit=browser-use-chrome-');
    expect(invocation).toContain(fakeBrowser);
    expect(invocation).toContain(`--user-data-dir=${profileDir}`);
  });

  it('falls back to a direct launch when the Linux systemd user manager rejects auto mode', async () => {
    const root = await temporaryRoot('bu-systemd-fallback-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const browserLog = path.join(root, 'browser-invocation');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await writeExecutable(path.join(fakeBin, 'systemctl'), '#!/bin/sh\ncase "$*" in *show-environment*) exit 0;; esac\nexit 1\n');
    await writeExecutable(path.join(fakeBin, 'systemd-run'), '#!/bin/sh\nexit 1\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/direct"}\\n\' "$port"\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_BROWSER_LOG"\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    const { stderr } = await run(wrapper, ['chrome', 'start'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_BROWSER_LAUNCH_MODE: 'auto',
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: path.join(root, 'runtime'),
      FAKE_BROWSER_LOG: browserLog,
    });

    expect(stderr).toContain('systemd launch failed; falling back to a direct browser launch');
    expect(await readFile(browserLog, 'utf8')).toContain(`--user-data-dir=${profileDir}`);
  });

  it('stops the exact systemd unit and releases its lock when Chrome never exposes CDP', async () => {
    const root = await temporaryRoot('bu-systemd-never-ready-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const runtimeBase = path.join(root, 'runtime');
    const configFile = path.join(root, 'bu.conf');
    const processFile = path.join(root, 'browser-pid');
    const stopLog = path.join(root, 'systemctl-stop');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await writeExecutable(path.join(fakeBin, 'systemd-run'), '#!/bin/sh\nsleep 10 &\nprintf "%s\\n" "$!" > "$FAKE_PROCESS_FILE"\n');
    await writeExecutable(path.join(fakeBin, 'systemctl'), `#!/bin/sh
case "$*" in
  *show-environment*) exit 0 ;;
  *MainPID*) cat "$FAKE_PROCESS_FILE" ;;
  *stop*)
    printf '%s\n' "$*" > "$FAKE_STOP_LOG"
    kill "$(cat "$FAKE_PROCESS_FILE")" 2>/dev/null || true
    ;;
  *) exit 1 ;;
esac
`);
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nexit 1\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nexit 0\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    let failure: { stderr?: string } | undefined;
    try {
      await run(wrapper, ['chrome', 'start'], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        BU_BROWSER_LAUNCH_MODE: 'systemd',
        BU_CONFIG_FILE: configFile,
        BU_RUNTIME_DIR: runtimeBase,
        BU_START_WAIT_ATTEMPTS: '1',
        BU_START_WAIT_INTERVAL: '0.01',
        FAKE_PROCESS_FILE: processFile,
        FAKE_STOP_LOG: stopLog,
      });
    } catch (error) {
      failure = error as { stderr?: string };
    }

    expect(failure?.stderr).toContain('configured Chrome did not expose a CDP endpoint');
    expect(await readFile(stopLog, 'utf8')).toContain('browser-use-chrome-');
    await expect(lstat(path.join(await profileRuntimeDirectory(runtimeBase, profileDir), 'chrome-start.lock'))).rejects.toThrow();
  });

  it('launches an app-bundled browser through macOS LaunchServices', async () => {
    const root = await temporaryRoot('bu-macos-launch-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const invocationLog = path.join(root, 'open-invocation');
    const appBundle = path.join(root, 'Fake Chrome.app');
    const fakeBrowser = path.join(appBundle, 'Contents', 'MacOS', 'Fake Chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    await writeExecutable(path.join(fakeBin, 'open'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_OPEN_LOG"\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/macos"}\\n\' "$port"\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nexit 0\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    const { stdout } = await run(wrapper, ['chrome', 'start'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_BROWSER_LAUNCH_MODE: 'launchservices',
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: path.join(root, 'runtime'),
      FAKE_OPEN_LOG: invocationLog,
    });

    const invocation = await readFile(invocationLog, 'utf8');
    expect(stdout).toMatch(/http:\/\/127\.0\.0\.1:[1-9]\d*/);
    expect(invocation).toContain(`-na ${appBundle}`);
    expect(invocation).toContain('--args');
    expect(invocation).toContain(`--user-data-dir=${profileDir}`);
  });

  it('falls back to a direct launch when macOS LaunchServices rejects auto mode', async () => {
    const root = await temporaryRoot('bu-macos-fallback-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const browserLog = path.join(root, 'browser-invocation');
    const appBundle = path.join(root, 'Fake Chrome.app');
    const fakeBrowser = path.join(appBundle, 'Contents', 'MacOS', 'Fake Chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    await writeExecutable(path.join(fakeBin, 'open'), '#!/bin/sh\nexit 1\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/direct"}\\n\' "$port"\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nprintf "%s\\n" "$*" > "$FAKE_BROWSER_LOG"\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    const { stderr } = await run(wrapper, ['chrome', 'start'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_BROWSER_LAUNCH_MODE: 'auto',
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: path.join(root, 'runtime'),
      FAKE_BROWSER_LOG: browserLog,
    });

    expect(stderr).toContain('LaunchServices launch failed; falling back to a direct browser launch');
    expect(await readFile(browserLog, 'utf8')).toContain(`--user-data-dir=${profileDir}`);
  });

  it('retains a discoverable lock when LaunchServices accepts a launch with no observable PID', async () => {
    const root = await temporaryRoot('bu-macos-accepted-lock-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const runtimeBase = path.join(root, 'runtime');
    const configFile = path.join(root, 'bu.conf');
    const appBundle = path.join(root, 'Fake Chrome.app');
    const fakeBrowser = path.join(appBundle, 'Contents', 'MacOS', 'Fake Chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
    await writeExecutable(path.join(fakeBin, 'open'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nexit 1\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nexit 0\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    try {
      await run(wrapper, ['chrome', 'start'], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        BU_BROWSER_LAUNCH_MODE: 'launchservices',
        BU_CONFIG_FILE: configFile,
        BU_RUNTIME_DIR: runtimeBase,
        BU_START_WAIT_ATTEMPTS: '1',
        BU_START_WAIT_INTERVAL: '0.01',
      });
    } catch {
      // The accepted app has not exposed CDP yet; its lock must remain discoverable.
    }

    const lockDir = path.join(await profileRuntimeDirectory(runtimeBase, profileDir), 'chrome-start.lock');
    expect((await readFile(path.join(lockDir, 'backend'), 'utf8')).trim()).toBe('launchservices');
    expect((await readFile(path.join(lockDir, 'port'), 'utf8')).trim()).toMatch(/^[1-9]\d*$/);
  });

  it.each([
    ['Linux', 'launchservices', 'macOS LaunchServices is unavailable'],
    ['Darwin', 'systemd', 'systemd user manager is unavailable'],
  ])('does not route explicit %s-incompatible launch mode %s through another backend', async (platform, launchMode, expectedError) => {
    const root = await temporaryRoot('bu-explicit-backend-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const managerLog = path.join(root, 'manager-invocation');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'uname'), `#!/bin/sh\nprintf '${platform}\\n'\n`);
    await writeExecutable(path.join(fakeBin, 'systemctl'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'systemd-run'), '#!/bin/sh\nprintf "systemd\\n" >> "$FAKE_MANAGER_LOG"\n');
    await writeExecutable(path.join(fakeBin, 'open'), '#!/bin/sh\nprintf "open\\n" >> "$FAKE_MANAGER_LOG"\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nprintf "direct\\n" >> "$FAKE_MANAGER_LOG"\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    let failure: { stderr?: string } | undefined;
    try {
      await run(wrapper, ['chrome', 'start'], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        BU_BROWSER_LAUNCH_MODE: launchMode,
        BU_CONFIG_FILE: configFile,
        BU_RUNTIME_DIR: path.join(root, 'runtime'),
        FAKE_MANAGER_LOG: managerLog,
      });
    } catch (error) {
      failure = error as { stderr?: string };
    }

    expect(failure?.stderr).toContain(expectedError);
    await expect(readFile(managerLog, 'utf8')).rejects.toThrow();
  });

  it('rejects an unknown browser launch mode before invoking Chrome', async () => {
    const root = await temporaryRoot('bu-invalid-launch-mode-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const browserLog = path.join(root, 'browser-invocation');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nprintf "started\\n" > "$FAKE_BROWSER_LOG"\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    let failure: { stderr?: string } | undefined;
    try {
      await run(wrapper, ['chrome', 'start'], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        BU_BROWSER_LAUNCH_MODE: 'unknown',
        BU_CONFIG_FILE: configFile,
        BU_RUNTIME_DIR: path.join(root, 'runtime'),
        FAKE_BROWSER_LOG: browserLog,
      });
    } catch (error) {
      failure = error as { stderr?: string };
    }

    expect(failure?.stderr).toContain('invalid BU_BROWSER_LAUNCH_MODE: unknown');
    await expect(readFile(browserLog, 'utf8')).rejects.toThrow();
  });

  it('fails immediately with a Codex host-permissions hint when the runtime is not writable', async () => {
    const root = await temporaryRoot('bu-runtime-permission-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const runtimeFile = path.join(root, 'runtime-file');
    const invocationLog = path.join(root, 'chrome-invocations');
    const configFile = path.join(root, 'bu.conf');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nprintf "started\\n" >> "$FAKE_CHROME_LOG"\n');
    await writeFile(runtimeFile, 'not a directory\n');
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    const startedAt = Date.now();
    let failure: { stderr?: string } | undefined;
    try {
      await run(wrapper, ['chrome', 'start'], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        BU_CONFIG_FILE: configFile,
        BU_RUNTIME_DIR: runtimeFile,
        BU_START_WAIT_ATTEMPTS: '100',
        BU_START_WAIT_INTERVAL: '0.2',
        FAKE_CHROME_LOG: invocationLog,
      });
    } catch (error) {
      failure = error as { stderr?: string };
    }

    expect(failure?.stderr).toContain(`browser-use runtime directory is not writable: ${runtimeFile}`);
    expect(failure?.stderr).toContain('sandbox_permissions="require_escalated"');
    expect(failure?.stderr).not.toContain('another Chrome may hold the profile lock');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(readFile(invocationLog, 'utf8')).rejects.toThrow();
  });

  it('fails immediately with a Codex host-permissions hint when the profile is not writable', async () => {
    const root = await temporaryRoot('bu-profile-permission-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const invocationLog = path.join(root, 'chrome-invocations');
    const configFile = path.join(root, 'bu.conf');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(fakeBrowser, '#!/bin/sh\nprintf "started\\n" >> "$FAKE_CHROME_LOG"\n');
    await mkdir(profileDir, { recursive: true });
    await chmod(profileDir, 0o500);
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    const startedAt = Date.now();
    let failure: { stderr?: string } | undefined;
    try {
      await run(wrapper, ['chrome', 'start'], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        BU_CONFIG_FILE: configFile,
        BU_RUNTIME_DIR: path.join(root, 'runtime'),
        BU_START_WAIT_ATTEMPTS: '100',
        BU_START_WAIT_INTERVAL: '0.2',
        FAKE_CHROME_LOG: invocationLog,
      });
    } catch (error) {
      failure = error as { stderr?: string };
    } finally {
      await chmod(profileDir, 0o700);
    }

    expect(failure?.stderr).toContain(`browser-use profile directory is not writable: ${profileDir}`);
    expect(failure?.stderr).toContain('sandbox_permissions="require_escalated"');
    expect(failure?.stderr).not.toContain('another Chrome may hold the profile lock');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(readFile(invocationLog, 'utf8')).rejects.toThrow();
  });

  it('does not duplicate a configured Chrome that remains alive beyond the caller wait', async () => {
    const root = await temporaryRoot('bu-slow-start-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const invocationLog = path.join(root, 'chrome-invocations');
    const configFile = path.join(root, 'bu.conf');
    const fakeBrowser = path.join(fakeBin, 'slow-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; test -f "$FAKE_CHROME_READY" || exit 1; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/slow"}\\n\' "$port"\n');
    await writeExecutable(fakeBrowser, `#!/usr/bin/env bash
set -eu
printf 'started\\n' >> "$FAKE_CHROME_LOG"
sleep 0.5
touch "$FAKE_CHROME_READY"
sleep 0.5
`);
    await mkdir(profileDir, { recursive: true });
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);
    const runtimeBase = path.join(root, 'runtime');
    const env = {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: runtimeBase,
      BU_START_WAIT_ATTEMPTS: '1',
      BU_START_WAIT_INTERVAL: '0.05',
      FAKE_CHROME_LOG: invocationLog,
      FAKE_CHROME_READY: path.join(root, 'chrome-ready'),
    };

    await Promise.allSettled([run(wrapper, ['chrome', 'start'], env), run(wrapper, ['chrome', 'start'], env)]);
    await new Promise((resolve) => setTimeout(resolve, 650));
    const { stdout } = await run(wrapper, ['chrome', 'start'], env);

    expect(stdout).toMatch(/http:\/\/127\.0\.0\.1:[1-9]\d*/);
    expect((await readFile(invocationLog, 'utf8')).trim().split('\n')).toHaveLength(1);
    await expect(lstat(path.join(await profileRuntimeDirectory(runtimeBase, profileDir), 'chrome-start.lock'))).rejects.toThrow();
  });

  it('recovers the Linux graphical session from the user systemd environment', async () => {
    const root = await temporaryRoot('bu-linux-systemd-display-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const browserEnvironment = path.join(root, 'browser-environment');
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await writeExecutable(path.join(fakeBin, 'systemctl'), `#!/bin/sh
printf '%s\n' 'XDG_RUNTIME_DIR=${root}/manager-runtime' 'WAYLAND_DISPLAY=wayland-7' 'DISPLAY=:7' 'XDG_SESSION_TYPE=wayland'
`);
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/display"}\\n\' "$port"\n');
    await writeExecutable(path.join(fakeBin, 'fake-chrome'), `#!/bin/sh
printf '%s|%s|%s|%s\n' "$WAYLAND_DISPLAY" "$DISPLAY" "$XDG_RUNTIME_DIR" "$XDG_SESSION_TYPE" > "$FAKE_CHROME_ENV"
`);
    await writeFile(configFile, `browser_binary=${path.join(fakeBin, 'fake-chrome')}\nprofile_dir=${profileDir}\n`);

    await run(wrapper, ['chrome', 'start'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: path.join(root, 'bu-runtime'),
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      XDG_RUNTIME_DIR: '',
      FAKE_CHROME_ENV: browserEnvironment,
    });

    expect((await readFile(browserEnvironment, 'utf8')).trim()).toBe(`wayland-7|:7|${root}/manager-runtime|wayland`);
  });

  it('infers a Linux Wayland socket when the user manager is inaccessible', async () => {
    const root = await temporaryRoot('bu-linux-socket-display-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const runtimeDir = path.join(root, 'desktop-runtime');
    const configFile = path.join(root, 'bu.conf');
    const browserEnvironment = path.join(root, 'browser-environment');
    const waylandSocket = path.join(runtimeDir, 'wayland-9');
    await mkdir(runtimeDir, { recursive: true });
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(waylandSocket, resolve);
    });
    await writeExecutable(path.join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await writeExecutable(path.join(fakeBin, 'systemctl'), '#!/bin/sh\nexit 1\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/display"}\\n\' "$port"\n');
    await writeExecutable(path.join(fakeBin, 'fake-chrome'), `#!/bin/sh
printf '%s|%s|%s\n' "$WAYLAND_DISPLAY" "$XDG_RUNTIME_DIR" "$XDG_SESSION_TYPE" > "$FAKE_CHROME_ENV"
`);
    await writeFile(configFile, `browser_binary=${path.join(fakeBin, 'fake-chrome')}\nprofile_dir=${profileDir}\n`);

    try {
      await run(wrapper, ['chrome', 'start'], {
        PATH: `${fakeBin}:${process.env.PATH}`,
        BU_CONFIG_FILE: configFile,
        BU_RUNTIME_DIR: path.join(root, 'bu-runtime'),
        DISPLAY: '',
        WAYLAND_DISPLAY: '',
        XDG_RUNTIME_DIR: runtimeDir,
        XDG_SESSION_TYPE: '',
        FAKE_CHROME_ENV: browserEnvironment,
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect((await readFile(browserEnvironment, 'utf8')).trim()).toBe(`wayland-9|${runtimeDir}|wayland`);
  });

  it.each(['Darwin', 'MINGW64_NT-10.0'])('does not perform Linux display recovery on %s', async (platform) => {
    const root = await temporaryRoot('bu-non-linux-display-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const configFile = path.join(root, 'bu.conf');
    const systemctlLog = path.join(root, 'systemctl-invocations');
    await writeExecutable(path.join(fakeBin, 'uname'), `#!/bin/sh\nprintf '${platform}\\n'\n`);
    await writeExecutable(path.join(fakeBin, 'systemctl'), '#!/bin/sh\nprintf "called\\n" >> "$FAKE_SYSTEMCTL_LOG"\nexit 1\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/display"}\\n\' "$port"\n');
    await writeExecutable(path.join(fakeBin, 'fake-chrome'), '#!/bin/sh\nexit 0\n');
    await writeFile(configFile, `browser_binary=${path.join(fakeBin, 'fake-chrome')}\nprofile_dir=${profileDir}\n`);

    await run(wrapper, ['chrome', 'start'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: path.join(root, 'bu-runtime'),
      DISPLAY: '',
      WAYLAND_DISPLAY: '',
      FAKE_SYSTEMCTL_LOG: systemctlLog,
    });

    await expect(readFile(systemctlLog, 'utf8')).rejects.toThrow();
  });

  it.each([
    ['empty', async (lockDir: string) => { await mkdir(lockDir, { recursive: true }); }],
    ['missing metadata', async (lockDir: string) => { await mkdir(lockDir, { recursive: true }); await writeFile(path.join(lockDir, 'owner'), 'interrupted\n'); }],
    ['interrupted cleanup', async (lockDir: string) => { await mkdir(lockDir, { recursive: true }); await writeFile(path.join(lockDir, 'started_at'), 'invalid\n'); }],
  ])('recovers an %s startup lock', async (_caseName, prepareLock) => {
    const root = await temporaryRoot('bu-stale-lock-');
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const runtimeDir = path.join(root, 'runtime');
    const profileRuntimeDir = await profileRuntimeDirectory(runtimeDir, profileDir);
    const invocationLog = path.join(root, 'chrome-invocations');
    const configFile = path.join(root, 'bu.conf');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'curl'), '#!/bin/sh\nurl=""; for argument in "$@"; do case "$argument" in http://127.0.0.1:*) url="$argument";; esac; done; port="${url#http://127.0.0.1:}"; port="${port%%/*}"; test -n "$port" || exit 1; printf \'{"webSocketDebuggerUrl":"ws://127.0.0.1:%s/devtools/browser/recovered"}\\n\' "$port"\n');
    await writeExecutable(fakeBrowser, `#!/usr/bin/env bash
set -eu
printf 'started\\n' >> "$FAKE_CHROME_LOG"
sleep 0.2
`);
    await mkdir(profileRuntimeDir, { recursive: true });
    await prepareLock(path.join(profileRuntimeDir, 'chrome-start.lock'));
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);

    const { stdout } = await run(wrapper, ['chrome', 'start'], {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: runtimeDir,
      BU_START_LOCK_GRACE: '0',
      BU_START_WAIT_ATTEMPTS: '10',
      BU_START_WAIT_INTERVAL: '0.01',
      FAKE_CHROME_LOG: invocationLog,
    });

    expect(stdout).toMatch(/http:\/\/127\.0\.0\.1:[1-9]\d*/);
    expect((await readFile(invocationLog, 'utf8')).trim()).toBe('started');
  });

  it('preserves explicit CDP overrides and injects the owned-target prelude', async () => {
    const root = await temporaryRoot('bu-session-');
    const fakeBin = path.join(root, 'bin');
    await writeExecutable(path.join(fakeBin, 'browser-use'), '#!/usr/bin/env bash\nprintf "cdp=%s name=%s bh=%s\\n" "$BU_CDP_URL" "$BU_NAME" "$BH_HOME"\ncat\n');
    const result = await runWithInput(wrapper, ['qa_session'], 'print("user-marker")\n', {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_CDP_URL: 'http://127.0.0.1:48765',
      XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
      BU_SESSION_TTL: '0',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('cdp=http://127.0.0.1:48765 name=bu_qa_session');
    expect(result.stdout).toContain(`bh=/tmp/browser-harness-${process.getuid?.() ?? 0}`);
    expect(result.stdout).toContain('_bu_tabs_file');
    expect(result.stdout).toContain('_bu_close_bootstrap_target');
    expect(result.stdout).toContain('print("user-marker")');

    // This case asserts the real BH_HOME, so it also stamps a marker there.
    // Remove it so the suite leaves no session records on the developer's box.
    await rm(path.join(`/tmp/browser-harness-${process.getuid?.() ?? 0}`, 'sessions', 'qa_session.lastuse'), { force: true });
  });

  it('closes a daemon bootstrap tab when the saved target is stale', async () => {
    const root = await temporaryRoot('bu-stale-target-');
    const stateDir = path.join(root, 'sessions');
    const targetFile = path.join(stateDir, 'stale_session.tabs');
    const runner = path.join(root, 'run-prelude.py');
    await mkdir(stateDir, { recursive: true });
    await writeFile(targetFile, 'missing-target\n');
    await writeFile(runner, `
import os
import sys
from pathlib import Path

events = []
bootstrap = {"targetId": "bootstrap-target", "url": "about:blank"}

def new_tab(url="about:blank"):
    raise AssertionError("new_tab should not be called")

def close_tab(target=None):
    # Upstream close_tab takes a raw target id as well as a dict.
    target = bootstrap if target is None else target
    events.append(target["targetId"] if isinstance(target, dict) else target)

def current_tab():
    return bootstrap

def list_tabs(include_chrome=False):
    return [bootstrap]

def switch_tab(target):
    raise AssertionError("switch_tab should not be called for a stale target")

try:
    exec(compile(Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec"), globals())
except RuntimeError as error:
    assert "lost its owned tab" in str(error)
else:
    raise AssertionError("stale target should raise")

assert events == ["bootstrap-target"], events
assert not Path(os.environ["BH_HOME"], "sessions", "stale_session.target").exists()
`);

    await run('uv', ['run', '--no-project', '--offline', 'python', runner, path.join(skillDir, 'session_prelude.py')], {
      BH_HOME: root,
      BU_SESSION_ID: 'stale_session',
    });
  });
});

describe('browser and profile discovery', () => {
  it('discovers Linux browser binaries, everyday profiles, and legacy dedicated profiles', async () => {
    const { discoverBrowserConfig } = await import('../skills/browser-use/scripts/discover-browser-config.mjs');
    const root = await temporaryRoot('bu-discovery-');
    const home = path.join(root, 'home');
    const fakeBin = path.join(root, 'bin');
    const chromeRoot = path.join(home, '.config', 'google-chrome');
    const defaultProfile = path.join(chromeRoot, 'Default');
    const dedicated = path.join(home, '.config', 'browser-use', 'default-profile');
    await writeExecutable(path.join(fakeBin, 'google-chrome-stable'), '#!/bin/sh\nexit 0\n');
    await mkdir(defaultProfile, { recursive: true });
    await mkdir(dedicated, { recursive: true });
    await writeFile(path.join(chromeRoot, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Work', user_name: 'person@example.com' } } } }));

    const result = await discoverBrowserConfig({ platform: 'linux', home, configHome: path.join(home, '.config'), pathEnv: fakeBin });

    expect(result.browsers).toHaveLength(1);
    expect(result.sourceProfiles[0]).toMatchObject({ profileDirectory: 'Default', displayName: 'Work', userName: 'person@example.com' });
    expect(result.dedicatedProfiles).toEqual([{ name: 'default-profile', path: await realpath(dedicated) }]);
  });

  it('defines macOS Chrome-family application and profile locations', async () => {
    const { browserDefinitions } = await import('../skills/browser-use/scripts/discover-browser-config.mjs');
    const definitions = browserDefinitions('darwin', '/Users/example');
    expect(definitions.map((item: { name: string }) => item.name)).toContain('Google Chrome');
    expect(definitions.find((item: { name: string }) => item.name === 'Google Chrome').binary).toContain('Google Chrome.app');
    expect(definitions.find((item: { name: string }) => item.name === 'Google Chrome').userDataDir).toContain('/Users/example/Library/Application Support');
  });
});

describe('in-memory cookie transfer', () => {
  it('filters exact domain suffixes, merges, and verifies without cookie artifacts', async () => {
    const { transferCookies } = await import('../skills/browser-use/scripts/transfer-cookies.mjs');
    const sourceCookies = [
      { name: 'root', value: 'secret-a', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: -1 },
      { name: 'sub', value: 'secret-b', domain: 'app.example.com', path: '/', secure: true, httpOnly: false, expires: -1 },
      { name: 'other', value: 'secret-c', domain: '.other.test', path: '/', secure: false, httpOnly: false, expires: -1 },
    ];
    let destinationCookies: typeof sourceCookies = [];
    const request = async (socket: string, method: string, params: { cookies?: typeof sourceCookies } = {}) => {
      if (socket === 'source' && method === 'Storage.getCookies') return { cookies: sourceCookies };
      if (socket === 'destination' && method === 'Storage.setCookies') {
        destinationCookies = [...(params.cookies || [])];
        return {};
      }
      if (socket === 'destination' && method === 'Storage.getCookies') return { cookies: destinationCookies };
      throw new Error(`Unexpected CDP call: ${socket} ${method}`);
    };
    const dependencies = {
      cdpRequest: request,
      webSocketUrlFromCdpUrl: async (url: string) => url.includes('source') ? 'source' : 'destination',
    };

    const result = await transferCookies({ sourceCdpUrl: 'http://source', destinationCdpUrl: 'http://destination', domains: ['example.com'], all: false }, dependencies);

    expect(result).toEqual({ scope: 'domains', imported: 2, verified: 2, sourceTotal: 3 });
    expect(destinationCookies.map((cookie) => cookie.domain)).toEqual(['.example.com', 'app.example.com']);
  });

  it('requires one explicit scope and supports confirmed all-cookie transfer', async () => {
    const { parseArgs, transferCookies } = await import('../skills/browser-use/scripts/transfer-cookies.mjs');
    expect(() => parseArgs(['--source-cdp-url', 'http://source', '--destination-cdp-url', 'http://destination'])).toThrow('Choose exactly one cookie scope');
    expect(() => parseArgs(['--source-cdp-url', 'http://source', '--destination-cdp-url', 'http://destination', '--all', '--domain', 'example.com'])).toThrow('Choose exactly one cookie scope');
    const cookies = [{ name: 'all', value: 'secret', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: -1 }];
    const result = await transferCookies(
      { sourceCdpUrl: 'http://source', destinationCdpUrl: 'http://destination', domains: [], all: true },
      {
        webSocketUrlFromCdpUrl: async (url: string) => url.includes('source') ? 'source' : 'destination',
        cdpRequest: async (socket: string, method: string) => method === 'Storage.setCookies' ? {} : { cookies: socket === 'source' ? cookies : cookies },
      },
    );
    expect(result).toEqual({ scope: 'all', imported: 1, verified: 1, sourceTotal: 1 });
  });

  it.each([
    { all: false, domains: ['example.com'] },
    { all: true, domains: [] },
  ])('rejects opaque partitioned cookies before any destination write for scope $all', async (scope) => {
    const { transferCookies } = await import('../skills/browser-use/scripts/transfer-cookies.mjs');
    let destinationWrites = 0;
    const opaqueCookie = { name: 'opaque', value: 'secret', domain: '.example.com', path: '/', partitionKeyOpaque: true };
    const request = async (socket: string, method: string) => {
      if (socket === 'source' && method === 'Storage.getCookies') return { cookies: [opaqueCookie] };
      if (socket === 'destination' && method === 'Storage.setCookies') destinationWrites += 1;
      return {};
    };

    await expect(transferCookies(
      { sourceCdpUrl: 'http://source', destinationCdpUrl: 'http://destination', ...scope },
      { cdpRequest: request, webSocketUrlFromCdpUrl: async (url: string) => url.includes('source') ? 'source' : 'destination' },
    )).rejects.toThrow('Refusing to transfer 1 opaque partitioned cookie');
    expect(destinationWrites).toBe(0);
  });
});

describe('cookie sync', () => {
  const syncScript = '../skills/browser-use/scripts/sync-cookies.mjs';

  it('requires a destination and one explicit scope', async () => {
    const { parseArgs } = await import(syncScript);
    const profile = ['--profile', 'me@example.com'];
    expect(() => parseArgs(['--domain', 'example.com', ...profile])).toThrow('Provide a destination');
    expect(() => parseArgs(['--to', 'host', '--all'])).toThrow('Provide the source profile');
    expect(() => parseArgs(['--to', 'host', '--all', '--profile', '   '])).toThrow('Provide the source profile');
    expect(() => parseArgs(['--to', 'host', ...profile])).toThrow('Choose exactly one cookie scope');
    expect(() => parseArgs(['--to', 'host', '--all', '--domain', 'example.com', ...profile])).toThrow('Choose exactly one cookie scope');
    expect(() => parseArgs(['--to', '-oProxyCommand=x', '--all', ...profile])).toThrow('Invalid destination');
    expect(() => parseArgs(['--to', 'host', '--all', '--expect', 'x', ...profile])).toThrow('--expect requires --check');
    expect(parseArgs(['--to', 'host', '--domain', '.Example.com', '--profile', 'me@example.com'])).toMatchObject({ to: 'host', domains: ['example.com'], profile: 'me@example.com' });
  });

  it('parses the bu chrome start endpoint', async () => {
    const { parseChromeStart } = await import(syncScript);
    expect(parseChromeStart('running: http://127.0.0.1:33709\n')).toEqual({ url: 'http://127.0.0.1:33709', port: 33709 });
    expect(() => parseChromeStart('stopped\n')).toThrow('Could not find a running CDP endpoint');
  });

  it('maps the served chrome://version profile to its account', async () => {
    const { resolveServedProfile } = await import(syncScript);
    const calls: string[] = [];
    const profile = await resolveServedProfile('/chrome', {
      webSocketUrlFromUserDataDir: async () => 'source',
      readFile: async () => JSON.stringify({ profile: { info_cache: { 'Profile 5': { user_name: 'me@example.com' } } } }),
      cdpSession: async (_socket: string, callback: (send: (method: string) => Promise<unknown>) => Promise<unknown>) => callback(async (method: string) => {
        calls.push(method);
        if (method === 'Target.createTarget') return { targetId: 't1' };
        if (method === 'Target.attachToTarget') return { sessionId: 's1' };
        if (method === 'Runtime.evaluate') return { result: { value: '/chrome/Profile 5' } };
        return {};
      }),
    });
    expect(profile).toEqual({ directory: 'Profile 5', userName: 'me@example.com' });
    expect(calls).toContain('Target.closeTarget');
  });

  it('refuses a profile mismatch before resolving the destination or reading cookies', async () => {
    const { syncCookies } = await import(syncScript);
    let touched = false;
    await expect(syncCookies(
      { to: 'host', profile: 'other@example.com', domains: ['example.com'], all: false, sourceUserDataDir: '/chrome' },
      {
        resolveServedProfile: async () => ({ directory: 'Profile 5', userName: 'me@example.com' }),
        runCommand: async () => { touched = true; return ''; },
        transferCookies: async () => { touched = true; return {}; },
      },
    )).rejects.toThrow('serves Profile 5 (me@example.com), not other@example.com');
    expect(touched).toBe(false);
  });

  it('closes the tunnel when the transfer fails', async () => {
    const { syncCookies } = await import(syncScript);
    const tunnel = { exitCode: null as number | null, killed: false, kill() { this.killed = true; this.exitCode = 0; } };
    let tunnelArgs: unknown[] = [];
    await expect(syncCookies(
      { to: 'host', profile: 'me@example.com', domains: ['example.com'], all: false, sourceUserDataDir: '/chrome' },
      {
        resolveServedProfile: async () => ({ directory: 'Profile 5', userName: 'me@example.com' }),
        runCommand: async () => 'running: http://127.0.0.1:33709\n',
        freePort: async () => 47000,
        openTunnel: (...args: unknown[]) => { tunnelArgs = args; return tunnel; },
        waitForCdp: async () => {},
        transferCookies: async () => { throw new Error('No source cookies matched the confirmed scope'); },
      },
    )).rejects.toThrow('No source cookies matched');
    expect(tunnelArgs).toEqual(['host', 47000, 33709]);
    expect(tunnel.killed).toBe(true);
  });

  it('transfers through the tunnel and reports the check without cookie values', async () => {
    const { syncCookies } = await import(syncScript);
    const tunnel = { exitCode: null as number | null, kill() { this.exitCode = 0; } };
    const commands: string[][] = [];
    let destination = '';
    const result = await syncCookies(
      { to: 'host', profile: 'me@example.com', domains: ['example.com'], all: false, sourceUserDataDir: '/chrome', check: 'https://example.com/me', expect: 'Sign Out' },
      {
        resolveServedProfile: async () => ({ directory: 'Profile 5', userName: 'me@example.com' }),
        runCommand: async (command: string, args: string[]) => {
          commands.push([command, ...args]);
          if (args.at(-1)?.includes('chrome start')) return 'running: http://127.0.0.1:33709\n';
          return 'noise\nSYNC_CHECK {"url": "https://example.com/me", "title": "Me", "expectFound": true}\n';
        },
        freePort: async () => 47000,
        openTunnel: () => tunnel,
        waitForCdp: async () => {},
        transferCookies: async (args: { destinationCdpUrl: string }) => {
          destination = args.destinationCdpUrl;
          return { scope: 'domains', imported: 2, verified: 2, sourceTotal: 9 };
        },
      },
    );
    expect(destination).toBe('http://127.0.0.1:47000');
    expect(result).toMatchObject({ destination: 'host', imported: 2, verified: 2, check: { url: 'https://example.com/me', expectFound: true } });
    expect(commands.at(-1)?.at(-1)).toMatch(/^bash -lc 'bu sync_check_[0-9a-f]{8} --end'$/);
  });

  it('keeps the transfer result when the check fails', async () => {
    const { syncCookies } = await import(syncScript);
    const result = await syncCookies(
      { to: 'local', profile: 'Profile 5', domains: ['example.com'], all: false, sourceUserDataDir: '/chrome', check: 'https://example.com/' },
      {
        resolveServedProfile: async () => ({ directory: 'Profile 5', userName: '' }),
        runCommand: async (_command: string, args: string[]) => {
          if (args.join(' ') === 'chrome start') return 'running: http://127.0.0.1:33709\n';
          throw new Error('bu failed: page crashed');
        },
        waitForCdp: async () => {},
        transferCookies: async () => ({ scope: 'domains', imported: 1, verified: 1, sourceTotal: 3 }),
      },
    );
    expect(result).toMatchObject({ imported: 1, verified: 1, check: { error: 'bu failed: page crashed' } });
  });

  it('builds a check script that only reports the expectation as a boolean', async () => {
    const { checkScript, parseCheckOutput } = await import(syncScript);
    const script = checkScript('https://example.com/', 'a "quoted" text');
    expect(script).toContain('goto_url("https://example.com/")');
    expect(script).toContain('document.body.innerText.includes(\\"a \\\\\\"quoted\\\\\\" text\\")');
    expect(parseCheckOutput('SYNC_CHECK {"url": "u", "title": "t", "expectFound": null}', undefined)).toEqual({ url: 'u', title: 't', loggedIn: 'unknown' });
  });
});

describe('bu session lifecycle', () => {
  async function lifecycleFixture(prefix: string) {
    const root = await temporaryRoot(prefix);
    const fakeBin = path.join(root, 'bin');
    const profileDir = path.join(root, 'profile');
    const runtimeDir = path.join(root, 'runtime');
    const bhHome = path.join(root, 'bh');
    const configFile = path.join(root, 'bu.conf');
    const closeLog = path.join(root, 'closed-tabs');
    const daemonLog = path.join(root, 'daemon-calls');
    const fakeBrowser = path.join(fakeBin, 'fake-chrome');

    await writeExecutable(fakeBrowser, '#!/bin/sh\nexit 0\n');
    await writeExecutable(path.join(fakeBin, 'browser-use'), `#!/bin/sh
printf '%s %s\\n' "\${BU_NAME:-none}" "$*" >> "${daemonLog}"
exit 0
`);
    await writeExecutable(path.join(fakeBin, 'curl'), `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    */json/close/*) printf '%s\\n' "\${argument##*/json/close/}" >> "${closeLog}"; printf 'Target is closing'; exit 0;;
    */json/version) printf '{"webSocketDebuggerUrl":"ws://127.0.0.1:45123/devtools/browser/test"}\\n'; exit 0;;
  esac
done
exit 1
`);
    await writeFile(configFile, `browser_binary=${fakeBrowser}\nprofile_dir=${profileDir}\n`);
    await mkdir(profileDir, { recursive: true });
    await mkdir(path.join(bhHome, 'sessions'), { recursive: true });
    const profileRuntime = await profileRuntimeDirectory(runtimeDir, profileDir);
    await mkdir(profileRuntime, { recursive: true });
    await writeFile(
      path.join(profileRuntime, 'DevToolsActivePort'),
      `45123\n/devtools/browser/test\n${profileDir}\n`,
    );

    const env = {
      PATH: `${fakeBin}:${process.env.PATH}`,
      BU_CONFIG_FILE: configFile,
      BU_RUNTIME_DIR: runtimeDir,
      BH_HOME: bhHome,
      BU_SWEEP_SYNC: '1',
    };
    const sessionsDir = path.join(bhHome, 'sessions');
    const seed = async (id: string, tabs: string[], ageSeconds: number) => {
      await writeFile(path.join(sessionsDir, `${id}.tabs`), `${tabs.join('\n')}\n`);
      await writeFile(path.join(sessionsDir, `${id}.lastuse`), '');
      const when = new Date(Date.now() - ageSeconds * 1000);
      await utimes(path.join(sessionsDir, `${id}.tabs`), when, when);
      await utimes(path.join(sessionsDir, `${id}.lastuse`), when, when);
    };
    const closed = async () => {
      try { return (await readFile(closeLog, 'utf8')).trim().split('\n').filter(Boolean); }
      catch { return []; }
    };
    const daemonCalls = async () => {
      try { return (await readFile(daemonLog, 'utf8')).trim().split('\n').filter(Boolean); }
      catch { return []; }
    };
    return { root, env, sessionsDir, seed, closed, daemonCalls, bhHome };
  }

  it('ends a session by closing every owned tab, stopping its daemon, and clearing its records', async () => {
    const fixture = await lifecycleFixture('bu-end-');
    await fixture.seed('work', ['TAB_ONE', 'TAB_TWO'], 0);

    await run(wrapper, ['work', '--end'], fixture.env);

    expect(await fixture.closed()).toEqual(['TAB_ONE', 'TAB_TWO']);
    expect(await fixture.daemonCalls()).toContain('bu_work --reload');
    expect(await readdir(fixture.sessionsDir)).toEqual([]);
  });

  it('treats --reload as an alias for --end so existing cleanup habits close tabs', async () => {
    const fixture = await lifecycleFixture('bu-alias-');
    await fixture.seed('legacy', ['ALIAS_TAB'], 0);

    await run(wrapper, ['legacy', '--reload'], fixture.env);

    expect(await fixture.closed()).toEqual(['ALIAS_TAB']);
    expect(await readdir(fixture.sessionsDir)).toEqual([]);
  });

  it('sweeps sessions idle past the TTL without ever sweeping the calling session', async () => {
    const fixture = await lifecycleFixture('bu-sweep-');
    await fixture.seed('stale', ['STALE_TAB'], 7200);
    await fixture.seed('caller', ['CALLER_TAB'], 7200);

    await runWithInput(wrapper, ['caller'], 'print(1)\n', { ...fixture.env, BU_SESSION_TTL: '60' });

    expect(await fixture.closed()).toEqual(['STALE_TAB']);
    const remaining = await readdir(fixture.sessionsDir);
    expect(remaining).not.toContain('stale.tabs');
    expect(remaining).toContain('caller.tabs');
  });

  it('rejects a session id that would be read as a flag', async () => {
    const fixture = await lifecycleFixture('bu-dashid-');

    const result = await runWithInput(wrapper, ['--end'], 'print(1)\n', fixture.env);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('SESSION_ID must match');
    expect(await readdir(fixture.sessionsDir)).toEqual([]);
  });

  it('records nothing for a passthrough call that never runs session code', async () => {
    const fixture = await lifecycleFixture('bu-passthrough-');

    await run(wrapper, ['probe', '--version'], fixture.env);

    expect(await readdir(fixture.sessionsDir)).toEqual([]);
    expect(await fixture.daemonCalls()).toContain('bu_probe --version');
  });

  it('keeps a session whose tabs file is old but which was used recently', async () => {
    const fixture = await lifecycleFixture('bu-active-');
    await fixture.seed('active', ['ACTIVE_TAB'], 7200);
    const now = new Date();
    await utimes(path.join(fixture.sessionsDir, 'active.lastuse'), now, now);
    await fixture.seed('other', ['OTHER_TAB'], 7200);

    await runWithInput(wrapper, ['driver'], 'print(1)\n', { ...fixture.env, BU_SESSION_TTL: '60' });

    expect(await fixture.closed()).toEqual(['OTHER_TAB']);
    expect(await readdir(fixture.sessionsDir)).toContain('active.tabs');
  });

  it('clears records and stops the daemon even when Chrome is gone', async () => {
    const fixture = await lifecycleFixture('bu-nochrome-');
    await fixture.seed('orphan', ['UNREACHABLE_TAB'], 0);
    await rm(path.join(await profileRuntimeDirectory(path.join(fixture.root, 'runtime'), path.join(fixture.root, 'profile')), 'DevToolsActivePort'));

    await run(wrapper, ['orphan', '--end'], fixture.env);

    expect(await fixture.closed()).toEqual([]);
    expect(await fixture.daemonCalls()).toContain('bu_orphan --reload');
    expect(await readdir(fixture.sessionsDir)).toEqual([]);
  });

  it('leaves other agents\' sessions alone when the CLI is updated', async () => {
    const fixture = await lifecycleFixture('bu-update-');
    await fixture.seed('one', ['ONE_TAB'], 0);
    await fixture.seed('two', ['TWO_TAB'], 0);

    await run(wrapper, ['--update'], fixture.env);

    // All sessions share one BH_HOME, so an update must not close tabs or
    // clear records belonging to a session someone else is still using.
    expect(await fixture.closed()).toEqual([]);
    expect((await readdir(fixture.sessionsDir)).sort())
      .toEqual(['one.lastuse', 'one.tabs', 'two.lastuse', 'two.tabs']);
  });
});

describe('bu session prelude ownership', () => {
  const preludePath = path.join(skillDir, 'session_prelude.py');

  async function runPrelude(options: {
    sessionId: string;
    body: string;
    seed?: (stateDir: string) => Promise<void>;
    liveTabs?: string[];
    bootUrl?: string;
    failNavigation?: boolean;
    realClose?: boolean;
    detached?: boolean;
    expectFailure?: boolean;
  }) {
    const root = await temporaryRoot('bu-prelude-own-');
    const stateDir = path.join(root, 'sessions');
    await mkdir(stateDir, { recursive: true });
    if (options.seed) await options.seed(stateDir);
    const runner = path.join(root, 'run.py');
    await writeFile(runner, `
import os, sys
from pathlib import Path

tabs = {"boot": {"targetId": "boot", "url": os.environ.get("BOOT_URL", "about:blank")}}
for extra in os.environ.get("LIVE_TABS", "").split(","):
    if extra:
        tabs[extra] = {"targetId": extra, "url": "https://example.test/"}
attached = "boot"
created = []
closed = []
closed_while_attached = []
state = {"detached": os.environ.get("DETACHED") == "1"}

def cdp(method, **params):
    global attached
    if method == "Target.createTarget":
        made = "created-%d" % (len(created) + 1)
        created.append(made)
        tabs[made] = {"targetId": made, "url": "about:blank"}
        return {"targetId": made}
    if method == "Runtime.evaluate":
        # Like the daemon: a page-level call on a dead session opens a blank
        # replacement tab and attaches to it.
        if state["detached"] or attached not in tabs:
            tabs["replacement"] = {"targetId": "replacement", "url": "about:blank"}
            attached = "replacement"
            state["detached"] = False
        return {}
    raise AssertionError(method)

def new_tab(url="about:blank"):
    raise AssertionError("upstream new_tab must never be called")

def close_tab(target=None):
    tid = target["targetId"] if isinstance(target, dict) else target
    if tid is None:
        tid = attached
    closed.append(tid)
    if tid == attached:
        closed_while_attached.append(tid)
    if os.environ.get("REAL_CLOSE") == "1":
        tabs.pop(tid, None)

def current_tab():
    if state["detached"] or attached not in tabs:
        raise RuntimeError("cdp_disconnected")
    return dict(tabs[attached])

def list_tabs(include_chrome=False):
    return list(tabs.values())

def switch_tab(target, activate=False):
    global attached
    attached = target["targetId"] if isinstance(target, dict) else target

def activate_tab(target):
    pass

def ensure_real_tab():
    raise AssertionError("upstream ensure_real_tab must never be called")

def js(expression, target_id=None):
    return "evaluated"

def goto_url(url):
    if os.environ.get("FAIL_NAV") == "1":
        raise RuntimeError("navigation failed")
    tabs[attached]["url"] = url

exec(compile(Path(sys.argv[1]).read_text(encoding="utf-8"), sys.argv[1], "exec"), globals())

${options.body}
`);
    const result = await run('uv', ['run', '--no-project', '--offline', 'python', runner, preludePath], {
      BH_HOME: root,
      BU_SESSION_ID: options.sessionId,
      LIVE_TABS: (options.liveTabs ?? []).join(','),
      BOOT_URL: options.bootUrl ?? 'about:blank',
      FAIL_NAV: options.failNavigation ? '1' : '0',
      REAL_CLOSE: options.realClose ? '1' : '0',
      DETACHED: options.detached ? '1' : '0',
    }).catch((error) => {
      if (!options.expectFailure) throw error;
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 };
    });
    return { ...result, stateDir };
  }

  it('refuses every way of reaching a tab another session owns', async () => {
    const { stdout } = await runPrelude({
      sessionId: 'intruder',
      seed: async (stateDir) => { await writeFile(path.join(stateDir, 'victim.tabs'), 'victim-tab\n'); },
      body: `
own = new_tab()
for label, call in [
    ("switch_tab", lambda: switch_tab("victim-tab")),
    ("activate_tab", lambda: activate_tab("victim-tab")),
    ("close_tab", lambda: close_tab("victim-tab")),
    ("js", lambda: js("1", target_id="victim-tab")),
]:
    try:
        call()
        raise AssertionError(label + " was not blocked")
    except PermissionError as error:
        assert "victim" in str(error), str(error)
assert "victim-tab" not in closed, closed
print("all-blocked")
`,
    });
    expect(stdout).toContain('all-blocked');
  });

  it('claims an unowned popup it switches into and can close it', async () => {
    const { stdout } = await runPrelude({
      sessionId: 'popup',
      liveTabs: ['popup-tab'],
      body: `
own = new_tab()
switch_tab("popup-tab")
assert js("1", target_id="popup-tab") == "evaluated"
assert "popup-tab" in _bu_read_tabs(), _bu_read_tabs()
close_tab("popup-tab")
assert "popup-tab" in closed, closed
print("unowned-tab-usable")
`,
    });
    expect(stdout).toContain('unowned-tab-usable');
  });

  it('owns a new tab before navigating so a failed navigation cannot orphan it', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'nav',
      failNavigation: true,
      body: `
try:
    new_tab("https://unreachable.test/")
    raise AssertionError("navigation should have failed")
except RuntimeError:
    pass
print("navigation-failed")
`,
    });
    expect(stdout).toContain('navigation-failed');
    expect(await readFile(path.join(stateDir, 'nav.tabs'), 'utf8')).toBe('created-1\n');
  });

  it('keeps a tab owned when Chrome did not actually close it', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'stubborn',
      body: `
first = new_tab()
second = new_tab()
close_tab(second)
print("close-returned")
`,
    });
    expect(stdout).toContain('close-returned');
    // The stub reports the close but leaves the target alive, so dropping
    // ownership here would strand a tab that --end could never reclaim.
    expect(await readFile(path.join(stateDir, 'stubborn.tabs'), 'utf8')).toContain('created-2');
  });

  it('reattaches to a surviving owned tab after closing the attached one', async () => {
    const { stdout } = await runPrelude({
      sessionId: 'reattach',
      realClose: true,
      body: `
first = new_tab()
second = new_tab()
close_tab(second)
assert current_tab()["targetId"] == first, current_tab()
print("reattached")
`,
    });
    expect(stdout).toContain('reattached');
  });

  it('keeps multiple owned tabs and lets the session move between them', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'multi',
      body: `
first = new_tab()
second = new_tab()
switch_tab(first)
assert current_tab()["targetId"] == first
print("moved-between-own-tabs")
`,
    });
    expect(stdout).toContain('moved-between-own-tabs');
    expect(await readFile(path.join(stateDir, 'multi.tabs'), 'utf8')).toBe('created-2\ncreated-1\n');
  });

  it('claims the blank attached tab when the session never calls new_tab', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'notab',
      body: `
assert js("1") == "evaluated"
print("worked-without-new-tab")
`,
    });
    expect(stdout).toContain('worked-without-new-tab');
    expect(await readFile(path.join(stateDir, 'notab.tabs'), 'utf8')).toBe('boot\n');
  });

  it('never claims or closes an attached tab another session owns', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'thief',
      seed: async (stateDir) => { await writeFile(path.join(stateDir, 'victim.tabs'), 'boot\n'); },
      body: `
new_tab()
assert "boot" not in closed, closed
print("ran")
`,
    });
    expect(stdout).toContain('ran');
    expect(await readFile(path.join(stateDir, 'thief.tabs'), 'utf8')).toBe('created-1\n');
    expect(await readFile(path.join(stateDir, 'victim.tabs'), 'utf8')).toBe('boot\n');
  });

  it('closes and forgets the unused attached tab when new_tab replaces it', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'replace',
      realClose: true,
      body: `
own = new_tab()
assert "boot" in closed, closed
print("replaced")
`,
    });
    expect(stdout).toContain('replaced');
    expect(await readFile(path.join(stateDir, 'replace.tabs'), 'utf8')).toBe('created-1\n');
  });

  it('keeps a claimed attached tab once the session has navigated it', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'navigated',
      realClose: true,
      body: `
goto_url("https://app.example.test/dashboard")
second = new_tab()
assert "boot" not in closed, closed
print("kept-working-tab")
`,
    });
    expect(stdout).toContain('kept-working-tab');
    expect(await readFile(path.join(stateDir, 'navigated.tabs'), 'utf8')).toBe('boot\ncreated-1\n');
  });

  it('does not close an unowned new-tab page during bootstrap cleanup', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'newtab',
      bootUrl: 'chrome://newtab/',
      realClose: true,
      body: `
new_tab()
assert "boot" not in closed, closed
print("kept-new-tab-page")
`,
    });
    expect(stdout).toContain('kept-new-tab-page');
    expect(await readFile(path.join(stateDir, 'newtab.tabs'), 'utf8')).toBe('created-1\n');
  });

  it('reports a lost tab instead of wedging when the daemon has no page left', async () => {
    const { stderr, stateDir } = await runPrelude({
      sessionId: 'wedged',
      detached: true,
      expectFailure: true,
      seed: async (stateDir) => { await writeFile(path.join(stateDir, 'wedged.tabs'), 'dead-tab\n'); },
      body: `
print("user code must not run")
`,
    });
    expect(stderr).toContain("lost its owned tab");
    expect(stderr).not.toContain('cdp_disconnected');
    // The record is cleared, so the next call starts clean with new_tab().
    expect(existsSync(path.join(stateDir, 'wedged.tabs'))).toBe(false);
  });

  it('claims the replacement tab the daemon opens after its attached tab died', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'recovered',
      detached: true,
      body: `
print("ran")
`,
    });
    expect(stdout).toContain('ran');
    expect(await readFile(path.join(stateDir, 'recovered.tabs'), 'utf8')).toBe('replacement\n');
  });

  it('moves to another owned tab before closing the attached one', async () => {
    const { stdout } = await runPrelude({
      sessionId: 'closeorder',
      realClose: true,
      body: `
first = new_tab()
second = new_tab()
close_tab()
assert closed_while_attached == [], closed_while_attached
assert current_tab()["targetId"] == first, current_tab()
print("moved-first")
`,
    });
    expect(stdout).toContain('moved-first');
  });

  it('opens and owns a replacement before closing its last tab', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'lasttab',
      realClose: true,
      body: `
own = new_tab()
close_tab()
assert closed_while_attached == [], closed_while_attached
assert current_tab()["targetId"] == "created-2", current_tab()
print("closed-last")
`,
    });
    expect(stdout).toContain('closed-last');
    expect(await readFile(path.join(stateDir, 'lasttab.tabs'), 'utf8')).toBe('created-1\ncreated-2\n');
  });

  it('never moves into a tab it just closed when closing twice in a row', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'doubleclose',
      body: `
a = new_tab()
b = new_tab()
close_tab()
close_tab()
current = current_tab()["targetId"]
assert current not in closed, (current, closed)
assert current in _bu_read_tabs(), (current, _bu_read_tabs())
print("landed-in-owned-tab")
`,
    });
    expect(stdout).toContain('landed-in-owned-tab');
    expect(await readFile(path.join(stateDir, 'doubleclose.tabs'), 'utf8')).toContain('created-3');
  });

  it('keeps a closed tab owned when ensure_real_tab runs before Chrome drops it', async () => {
    const { stdout, stateDir } = await runPrelude({
      sessionId: 'ensureclosed',
      body: `
a = new_tab()
b = new_tab()
close_tab()
assert ensure_real_tab()["targetId"] == a, current_tab()
print("still-owned")
`,
    });
    expect(stdout).toContain('still-owned');
    // Without REAL_CLOSE the stub leaves b listed, as a close that silently failed would.
    expect(await readFile(path.join(stateDir, 'ensureclosed.tabs'), 'utf8')).toContain('created-2');
  });

  it('keeps the guard working when another session record cannot be read', async () => {
    const { stdout } = await runPrelude({
      sessionId: 'reader',
      seed: async (stateDir) => {
        await mkdir(path.join(stateDir, 'broken.tabs'), { recursive: true });
        await writeFile(path.join(stateDir, 'victim.tabs'), 'victim-tab\n');
      },
      body: `
own = new_tab()
try:
    switch_tab("victim-tab")
    raise AssertionError("guard did not run")
except PermissionError:
    pass
print("guard-survived")
`,
    });
    expect(stdout).toContain('guard-survived');
  });
});
