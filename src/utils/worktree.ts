import { execa, type ExecaChildProcess } from 'execa';
import chalk from 'chalk';
import { readdir, mkdir, copyFile, cp, stat, lstat, rm } from 'node:fs/promises';
import { Dirent, openSync, writeSync, closeSync } from 'node:fs';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { resolveEditor, getExtraCopyPaths } from '../config.js';

const SKIP_DIR_NAMES = new Set(['node_modules', '.venv', '.git']);

function shouldSkipDirectory(dirent: Dirent): boolean {
    if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
        return false;
    }

    const name = dirent.name;
    if (SKIP_DIR_NAMES.has(name)) {
        return true;
    }
    return name.startsWith('.env');
}

async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await stat(targetPath);
        return true;
    } catch {
        return false;
    }
}

// Convert a copy-paths pattern into an anchored RegExp matched against a
// basename. Supports `*` (any run) and `?` (single char) globs; every other
// character is matched literally, so a pattern with no glob chars behaves as an
// exact-name match (backward compatible).
function compilePattern(pattern: string): RegExp {
    const body = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${body}$`);
}

interface CopySummary {
    envCopied: number;
    envSkipped: number;
    extraCopied: number;
    extraSkipped: number;
    extraDirsCopied: number;
    extraDirsSkipped: number;
}

export async function copyEnvFilesAndExtras(
    sourceRoot: string,
    destinationRoot: string,
    extraPaths: string[]
): Promise<CopySummary> {
    const summary: CopySummary = {
        envCopied: 0,
        envSkipped: 0,
        extraCopied: 0,
        extraSkipped: 0,
        extraDirsCopied: 0,
        extraDirsSkipped: 0,
    };

    // Prepare extra patterns (trim, deduplicate) and precompile their globs.
    const extraPatterns = Array.from(new Set(extraPaths.map((p) => p.trim())))
        .filter((p) => p.length > 0)
        .map((raw) => ({ raw, rx: compilePattern(raw) }));

    const stack: string[] = [sourceRoot];

    while (stack.length) {
        const currentDir = stack.pop();
        if (!currentDir) continue;

        let entries: Dirent[] = [];
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch (error) {
            console.warn(chalk.yellow(`Skipping unreadable directory: ${currentDir}`), error);
            continue;
        }

        for (const entry of entries) {
            const entryPath = join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (shouldSkipDirectory(entry)) {
                    continue;
                }

                // Check if this directory matches any extra patterns
                const matchesPattern = extraPatterns.some(({ rx }) => rx.test(entry.name));
                if (matchesPattern) {
                    const relativePath = relative(sourceRoot, entryPath);
                    const destinationPath = join(destinationRoot, relativePath);

                    try {
                        if (await pathExists(destinationPath)) {
                            summary.extraDirsSkipped += 1;
                            continue;
                        }

                        await mkdir(dirname(destinationPath), { recursive: true });
                        await cp(entryPath, destinationPath, {
                            recursive: true,
                            force: true,
                            errorOnExist: false,
                            dereference: false,
                        });
                        summary.extraDirsCopied += 1;
                    } catch (error) {
                        console.warn(
                            chalk.yellow(`Failed to copy directory ${relativePath} into new worktree.`),
                            error
                        );
                    }
                    // Don't traverse into this directory since we copied it entirely
                    continue;
                }

                stack.push(entryPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const relativePath = relative(sourceRoot, entryPath);
            const destinationPath = join(destinationRoot, relativePath);

            // Check if this file matches .env* pattern
            if (entry.name.startsWith('.env')) {
                try {
                    await mkdir(dirname(destinationPath), { recursive: true });
                    if (await pathExists(destinationPath)) {
                        summary.envSkipped += 1;
                        continue;
                    }

                    await copyFile(entryPath, destinationPath);
                    summary.envCopied += 1;
                } catch (error) {
                    console.warn(
                        chalk.yellow(`Failed to copy ${relativePath} into new worktree.`),
                        error
                    );
                }
                continue;
            }

            // Check if this file matches any extra patterns
            const matchesPattern = extraPatterns.some(({ rx }) => rx.test(entry.name));
            if (matchesPattern) {
                try {
                    await mkdir(dirname(destinationPath), { recursive: true });
                    if (await pathExists(destinationPath)) {
                        summary.extraSkipped += 1;
                        continue;
                    }

                    await copyFile(entryPath, destinationPath);
                    summary.extraCopied += 1;
                } catch (error) {
                    console.warn(
                        chalk.yellow(`Failed to copy ${relativePath} into new worktree.`),
                        error
                    );
                }
            }
        }
    }

    if (summary.envCopied > 0) {
        console.log(chalk.green(`Copied ${summary.envCopied} environment file(s).`));
    }
    if (summary.envSkipped > 0) {
        console.log(
            chalk.yellow(
                `Skipped ${summary.envSkipped} environment file(s) that already existed in the destination.`
            )
        );
    }

    if (summary.extraCopied > 0) {
        console.log(chalk.green(`Copied ${summary.extraCopied} extra file(s) matching configured patterns.`));
    }
    if (summary.extraSkipped > 0) {
        console.log(chalk.yellow(`Skipped ${summary.extraSkipped} extra file(s) that already existed.`));
    }

    if (summary.extraDirsCopied > 0) {
        console.log(chalk.green(`Copied ${summary.extraDirsCopied} extra director(ies) matching configured patterns.`));
    }
    if (summary.extraDirsSkipped > 0) {
        console.log(chalk.yellow(`Skipped ${summary.extraDirsSkipped} extra director(ies) that already existed.`));
    }

    return summary;
}

type AutoDetectedManager = 'npm' | 'yarn' | 'uv';

interface LockFileInfo {
    manager: AutoDetectedManager;
    directory: string;
    lockFile: string;
}

const LOCKFILE_MANAGER_MAP: Record<string, AutoDetectedManager> = {
    'package-lock.json': 'npm',
    'yarn.lock': 'yarn',
    'uv.lock': 'uv',
};

export function resolveInstallCommand(manager: string): { command: string; args: string[] } {
    const normalized = manager.toLowerCase();
    switch (normalized) {
        case 'npm':
        case 'yarn':
        case 'pnpm':
        case 'bun':
            return { command: normalized, args: ['install'] };
        case 'uv':
            return { command: 'uv', args: ['sync'] };
        default:
            return { command: normalized, args: ['install'] };
    }
}

async function discoverLockFiles(root: string): Promise<LockFileInfo[]> {
    const results: LockFileInfo[] = [];
    const queue: string[] = [root];

    while (queue.length) {
        const currentDir = queue.pop();
        if (!currentDir) continue;

        let entries: Dirent[] = [];
        try {
            entries = await readdir(currentDir, { withFileTypes: true });
        } catch (error) {
            console.warn(chalk.yellow(`Skipping unreadable directory during lockfile discovery: ${currentDir}`), error);
            continue;
        }

        for (const entry of entries) {
            const entryPath = join(currentDir, entry.name);

            if (entry.isDirectory()) {
                if (shouldSkipDirectory(entry)) {
                    continue;
                }
                queue.push(entryPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const manager = LOCKFILE_MANAGER_MAP[entry.name];
            if (!manager) {
                continue;
            }

            results.push({
                manager,
                directory: currentDir,
                lockFile: entryPath,
            });
        }
    }

    return results;
}

interface InstallSummary {
    executed: LockFileInfo[];
    manual?: { manager: string; directory: string };
    // Set when the user interrupted the install with Ctrl+C. The worktree is
    // still fully created; only the install was skipped.
    cancelled?: boolean;
}

interface InstallJob {
    manager: string;
    directory: string;
    lockFile?: LockFileInfo;
}

export async function installDependencies(
    worktreePath: string,
    installOption?: string
): Promise<InstallSummary> {
    // Handle skip
    if (installOption === 'skip') {
        console.log(chalk.blue('Skipping dependency installation.'));
        return { executed: [] };
    }

    const summary: InstallSummary = { executed: [] };
    const jobs: InstallJob[] = [];

    if (installOption && installOption !== 'auto') {
        // Explicit manager: a single install at the worktree root.
        summary.manual = { manager: installOption, directory: worktreePath };
        jobs.push({ manager: installOption.toLowerCase(), directory: worktreePath });
    } else {
        // Auto-detect (installOption is undefined or 'auto')
        console.log(chalk.blue('Auto-detecting lock files for dependency installation...'));
        const lockFiles = await discoverLockFiles(worktreePath);
        if (!lockFiles.length) {
            console.log(chalk.blue('No lock files detected for auto-install.'));
            return summary;
        }
        for (const info of lockFiles) {
            jobs.push({ manager: info.manager, directory: info.directory, lockFile: info });
        }
    }

    // Installs run LAST in the create flow, so cancelling them leaves a fully
    // usable worktree behind. Registering a SIGINT listener both suppresses
    // Node's default insta-terminate (so we can exit cleanly) and lets us stop
    // the loop; the child install shares our foreground process group, so
    // Ctrl+C already reaches it too.
    let cancelled = false;
    let currentChild: ExecaChildProcess | undefined;
    const onSigint = () => {
        cancelled = true;
        currentChild?.kill('SIGINT');
    };
    process.on('SIGINT', onSigint);

    console.log(
        chalk.blue('Installing dependencies (press Ctrl+C to skip — the worktree is already usable for editing)...')
    );

    try {
        for (const job of jobs) {
            if (cancelled) break;

            if (job.lockFile) {
                const relativeDir = relative(worktreePath, job.directory) || '.';
                console.log(
                    chalk.blue(`Detected ${job.lockFile.lockFile} (manager: ${job.manager}) in ${relativeDir}.`)
                );
            }

            const { command, args } = resolveInstallCommand(job.manager);
            console.log(chalk.blue(`Running ${command} ${args.join(' ')} in ${job.directory}`));

            try {
                currentChild = execa(command, args, { cwd: job.directory, stdio: 'inherit' });
                await currentChild;
                if (job.lockFile) summary.executed.push(job.lockFile);
            } catch (error: any) {
                if (cancelled) break;
                // A genuine install failure (not a Ctrl+C): warn and keep going.
                // The worktree is already usable; don't fail its creation over it.
                console.error(
                    chalk.red(`Failed to install dependencies with ${command} in ${job.directory}:`),
                    error?.shortMessage || error?.message || error
                );
                console.warn(chalk.yellow('Continuing — the worktree is ready; you can install manually later.'));
            } finally {
                currentChild = undefined;
            }
        }
    } finally {
        process.removeListener('SIGINT', onSigint);
    }

    if (cancelled) {
        console.log(
            chalk.yellow('\nDependency install cancelled — the worktree is ready. Run the install manually there when you want.')
        );
        summary.cancelled = true;
    }

    return summary;
}

interface ReplicationSummary {
    copied: string[];
    removed: string[];
    missing: string[];
}

function parseNullSeparated(stdout: string): string[] {
    if (!stdout) return [];
    return stdout
        .split('\0')
        .filter((entry) => entry.length > 0);
}

export async function replicateWorkingTreeState(
    sourceRoot: string,
    destinationRoot: string
): Promise<ReplicationSummary> {
    console.log(chalk.blue('Replicating current working tree state into the new worktree...'));

    const summary: ReplicationSummary = {
        copied: [],
        removed: [],
        missing: [],
    };

    const filesToCopy = new Set<string>();
    const deletions = new Set<string>();

    let diffNamesStdout = '';
    try {
        const diffNamesResult = await execa('git', ['diff', '--name-only', 'HEAD', '-z'], {
            cwd: sourceRoot,
        });
        diffNamesStdout = diffNamesResult.stdout;
    } catch (error: any) {
        if (error.exitCode !== 128) {
            throw error;
        }
        // exitCode 128 typically means no commits yet; ignore.
    }

    parseNullSeparated(diffNamesStdout).forEach((path) => filesToCopy.add(path));

    let untrackedStdout = '';
    try {
        const untrackedResult = await execa('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
            cwd: sourceRoot,
        });
        untrackedStdout = untrackedResult.stdout;
    } catch (error) {
        console.warn(chalk.yellow('Failed to detect untracked files for replication.'), error);
    }

    parseNullSeparated(untrackedStdout).forEach((path) => filesToCopy.add(path));

    let statusStdout = '';
    try {
        const statusResult = await execa('git', ['diff', '--name-status', 'HEAD', '-z'], {
            cwd: sourceRoot,
        });
        statusStdout = statusResult.stdout;
    } catch (error: any) {
        if (error.exitCode !== 128) {
            throw error;
        }
    }

    const statusEntries = parseNullSeparated(statusStdout);
    // With -z flag, git outputs: status\0filename\0status\0filename\0
    // After splitting by \0, we get pairs: [status, filename, status, filename, ...]
    for (let i = 0; i < statusEntries.length; i++) {
        const status = statusEntries[i];
        if (!status) continue;

        const code = status[0];

        if (code === 'D') {
            const filename = statusEntries[i + 1];
            if (filename) {
                deletions.add(filename);
            }
            i++; // Skip the filename we just processed
            continue;
        }

        if (code === 'R') {
            // For renames: R\0oldname\0newname\0
            const fromPath = statusEntries[i + 1];
            const toPath = statusEntries[i + 2];
            if (fromPath) {
                deletions.add(fromPath);
            }
            if (toPath) {
                filesToCopy.add(toPath);
            }
            i += 2; // Skip both paths we just processed
            continue;
        }

        // For other status codes (M, A, etc.)
        const filename = statusEntries[i + 1];
        if (filename) {
            filesToCopy.add(filename);
        }
        i++; // Skip the filename we just processed
    }

    deletions.forEach((path) => filesToCopy.delete(path));

    for (const relativePath of filesToCopy) {
        const sourcePath = join(sourceRoot, relativePath);
        const destinationPath = join(destinationRoot, relativePath);

        if (!(await pathExists(sourcePath))) {
            summary.missing.push(relativePath);
            continue;
        }

        try {
            await mkdir(dirname(destinationPath), { recursive: true });
            const stats = await lstat(sourcePath);
            await cp(sourcePath, destinationPath, {
                recursive: stats.isDirectory(),
                force: true,
                errorOnExist: false,
                dereference: false,
            });
            summary.copied.push(relativePath);
        } catch (error) {
            console.warn(chalk.yellow(`Failed to copy ${relativePath} to the new worktree.`), error);
        }
    }

    for (const relativePath of deletions) {
        const destinationPath = join(destinationRoot, relativePath);
        try {
            await rm(destinationPath, { recursive: true, force: true });
            summary.removed.push(relativePath);
        } catch (error) {
            console.warn(chalk.yellow(`Failed to remove ${relativePath} in the new worktree.`), error);
        }
    }

    if (summary.copied.length) {
        console.log(chalk.green(`Copied ${summary.copied.length} file(s) from the source worktree.`));
    }
    if (summary.removed.length) {
        console.log(chalk.green(`Removed ${summary.removed.length} file(s) to mirror deletions.`));
    }
    if (summary.missing.length) {
        console.log(
            chalk.yellow(
                `Skipped ${summary.missing.length} file(s) because they were not present in the source worktree.`
            )
        );
    }

    if (!summary.copied.length && !summary.removed.length) {
        console.log(chalk.blue('No changes to replicate; worktree matches HEAD.'));
    }

    return summary;
}

function resolveGitDir(basePath: string, gitDirValue: string): string {
    const trimmed = gitDirValue.trim();
    return isAbsolute(trimmed) ? trimmed : resolve(basePath, trimmed);
}

// Copy `text` to the *local* clipboard using the OSC 52 terminal escape. The
// terminal emulator (running on your machine, even when the CLI is on a remote
// host over SSH) intercepts the escape and writes to the local clipboard — the
// only mechanism that reaches the Mac clipboard from an SSH session. Requires a
// terminal with clipboard-write enabled (Ghostty/kitty/iTerm2 by default) and,
// inside tmux, `set -g set-clipboard on` + `set -g allow-passthrough on`.
function copyViaOsc52(text: string): boolean {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    // OSC 52: ESC ] 52 ; c ; <base64> BEL
    let sequence = `\x1b]52;c;${b64}\x07`;

    // Inside tmux, wrap the escape in a passthrough DCS so tmux forwards it to
    // the outer terminal instead of swallowing it. Every ESC in the payload must
    // be doubled.
    if (process.env.TMUX) {
        sequence = `\x1bPtmux;${sequence.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
    }

    // Write straight to the controlling terminal so the escape reaches the
    // emulator even when stdout is piped or redirected.
    try {
        const fd = openSync('/dev/tty', 'w');
        try {
            writeSync(fd, sequence);
        } finally {
            closeSync(fd);
        }
        return true;
    } catch {
        // No /dev/tty (e.g. Windows or a non-interactive run). Fall back to
        // stdout, but only when it's an actual TTY.
        if (process.stdout.isTTY) {
            try {
                process.stdout.write(sequence);
                return true;
            } catch {
                // Fall through to failure.
            }
        }
        return false;
    }
}

export async function copyToClipboard(text: string): Promise<boolean> {
    // Ordered clipboard backends to try for the current platform; the first one
    // that exists and succeeds wins. Linux covers both Wayland (wl-copy) and X11
    // (xclip/xsel); a headless/SSH session may have none, in which case we quietly
    // report failure so callers can skip the "copied to clipboard" message.
    const candidates: Array<{ command: string; args: string[] }> =
        process.platform === 'darwin'
            ? [{ command: 'pbcopy', args: [] }]
            : process.platform === 'win32'
                ? [{ command: 'clip', args: [] }]
                : [
                    { command: 'wl-copy', args: [] },
                    { command: 'xclip', args: ['-selection', 'clipboard'] },
                    { command: 'xsel', args: ['--clipboard', '--input'] },
                ];

    const tryNative = async (): Promise<boolean> => {
        for (const { command, args } of candidates) {
            try {
                await execa(command, args, { input: text });
                return true;
            } catch {
                // Backend missing or failed; fall through to the next candidate.
            }
        }
        return false;
    };

    const tryOsc52 = async (): Promise<boolean> => copyViaOsc52(text);

    // Over SSH the native backends target the *remote* host's clipboard (or fail
    // outright with no display), so prefer OSC 52, which the local terminal
    // emulator turns into a real local-clipboard write. Locally, prefer the
    // native backend and use OSC 52 only as a fallback.
    const overSsh = !!(
        process.env.SSH_CONNECTION ||
        process.env.SSH_TTY ||
        process.env.SSH_CLIENT
    );
    const strategies = overSsh ? [tryOsc52, tryNative] : [tryNative, tryOsc52];

    for (const strategy of strategies) {
        if (await strategy()) {
            return true;
        }
    }
    return false;
}

interface FinalizeWorktreeOptions {
    install?: string;
    editor?: string;
}

/**
 * Shared tail for `gdev wt new` / `gdev wt copy`. Ordered so the worktree is ready to
 * work in BEFORE the (possibly slow) dependency install: copy env files +
 * configured extras, open the editor if one is configured, announce readiness
 * and copy a `cd <path>` command to the clipboard, then install dependencies
 * LAST (which is interruptible with Ctrl+C). Returns the editor command used
 * (or null when none was opened) and whether the clipboard copy succeeded.
 */
export async function finalizeWorktree(
    repoRoot: string,
    resolvedPath: string,
    options: FinalizeWorktreeOptions
): Promise<{ editorCommand: string | null; copied: boolean }> {
    console.log(chalk.blue('Copying environment files and configured extras...'));
    const extraPaths = getExtraCopyPaths();
    await copyEnvFilesAndExtras(repoRoot, resolvedPath, extraPaths);

    // Open the editor (if configured) up front, so it's available while deps
    // install. GUI editors (code/cursor/…) return immediately.
    const editorCommand = resolveEditor(options.editor);
    if (editorCommand) {
        console.log(chalk.blue(`Opening ${resolvedPath} in ${editorCommand}...`));
        try {
            await execa(editorCommand, [resolvedPath], { stdio: 'inherit' });
        } catch {
            console.error(
                chalk.red(`Failed to open editor "${editorCommand}". Please ensure it's installed and in your PATH.`)
            );
            console.warn(chalk.yellow('Continuing without opening editor.'));
        }
    }

    // Announce readiness and hand over the `cd` command BEFORE installing, so
    // you can open a new tab and start working immediately (or Ctrl+C the
    // install below without losing anything).
    const cdCommand = `cd ${resolvedPath}`;
    const copied = await copyToClipboard(cdCommand);
    console.log(chalk.green(`✅ Worktree ready at ${resolvedPath}.`));
    if (copied) {
        console.log(chalk.cyan(`📋 "${cdCommand}" copied to clipboard.`));
    }

    // Install last so cancelling it leaves the worktree fully intact.
    await installDependencies(resolvedPath, options.install);

    return { editorCommand, copied };
}

export async function duplicateGitIndex(sourceRoot: string, destinationRoot: string): Promise<void> {
    try {
        const [sourceGitDirResult, destinationGitDirResult] = await Promise.all([
            execa('git', ['rev-parse', '--git-dir'], { cwd: sourceRoot }),
            execa('git', ['rev-parse', '--git-dir'], { cwd: destinationRoot }),
        ]);

        const sourceGitDir = resolveGitDir(sourceRoot, sourceGitDirResult.stdout);
        const destinationGitDir = resolveGitDir(destinationRoot, destinationGitDirResult.stdout);

        const sourceIndexPath = join(sourceGitDir, 'index');
        const destinationIndexPath = join(destinationGitDir, 'index');

        if (!(await pathExists(sourceIndexPath))) {
            console.warn(chalk.yellow('Source git index not found; staged changes will not be copied.'));
            return;
        }

        await mkdir(dirname(destinationIndexPath), { recursive: true });
        await copyFile(sourceIndexPath, destinationIndexPath);
        console.log(chalk.green('Synced staged changes into the new worktree.'));
    } catch (error) {
        console.warn(chalk.yellow('Failed to synchronize git index between worktrees.'), error);
    }
}
