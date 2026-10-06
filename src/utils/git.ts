import { execa } from "execa";
import chalk from "chalk";
import { resolve } from "node:path";

export interface WorktreeEntry {
    path: string;
    head: string;
    branch: string | null;
    isDetached: boolean;
    isPrunable: boolean;
    /** The first porcelain entry is always the repo's main worktree. */
    isMain: boolean;
    locked: boolean;
    lockReason: string | null;
}

export function parseWorktreeList(porcelainOutput: string): WorktreeEntry[] {
    const entries: WorktreeEntry[] = [];
    const blocks = porcelainOutput.split("\n\n").filter(block => block.trim() !== "");

    for (const block of blocks) {
        const lines = block.split("\n");
        let path = "";
        let head = "";
        let branch: string | null = null;
        let isDetached = false;
        let isPrunable = false;
        let locked = false;
        let lockReason: string | null = null;

        for (const line of lines) {
            if (line.startsWith("worktree ")) {
                path = line.replace("worktree ", "").trim();
            } else if (line.startsWith("HEAD ")) {
                head = line.replace("HEAD ", "").trim();
            } else if (line.startsWith("branch ")) {
                const fullBranch = line.replace("branch ", "").trim();
                branch = fullBranch.replace("refs/heads/", "");
            } else if (line.trim() === "detached") {
                isDetached = true;
            } else if (line.startsWith("prunable")) {
                isPrunable = true;
            } else if (line === "locked" || line.startsWith("locked ")) {
                // Porcelain emits a bare "locked" line, or "locked <reason>".
                locked = true;
                const reason = line.replace(/^locked\s?/, "").trim();
                lockReason = reason || null;
            }
        }

        if (path) {
            entries.push({
                path,
                head,
                branch,
                isDetached,
                isPrunable,
                // The main worktree is always listed first by `git worktree list`.
                isMain: entries.length === 0,
                locked,
                lockReason,
            });
        }
    }

    return entries;
}

export async function getWorktreeList(): Promise<WorktreeEntry[]> {
    const { stdout } = await execa("git", ["worktree", "list", "--porcelain"]);
    return parseWorktreeList(stdout);
}

/**
 * Find a worktree by branch name. Returns null when no worktree tracks it.
 */
export async function findWorktreeByBranch(branchName: string): Promise<WorktreeEntry | null> {
    const worktrees = await getWorktreeList();
    return worktrees.find(wt => wt.branch === branchName) ?? null;
}

/**
 * Find a worktree by filesystem path. Paths are resolved before comparison so
 * relative and absolute forms of the same directory match.
 */
export async function findWorktreeByPath(targetPath: string): Promise<WorktreeEntry | null> {
    const resolved = resolve(targetPath);
    const worktrees = await getWorktreeList();
    return worktrees.find(wt => resolve(wt.path) === resolved) ?? null;
}

export async function getCurrentBranch(cwd: string = "."): Promise<string | null> {
    try {
        const { stdout } = await execa("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
        return stdout.trim();
    } catch (error) {
        // Handle case where HEAD is detached or not in a git repo
        console.error(chalk.yellow("Could not determine current branch."), error);
        return null;
    }
}

export async function isWorktreeClean(worktreePath: string = "."): Promise<boolean> {
    try {
        // Use --porcelain to get easily parsable output.
        // An empty output means clean (for tracked files).
        // We check the specific worktree path provided, defaulting to current dir.
        const { stdout } = await execa("git", ["-C", worktreePath, "status", "--porcelain"]);

        // If stdout is empty, the worktree is clean regarding tracked/staged files.
        // You might also consider ignoring untracked files depending on strictness,
        // but for operations like checkout, it's safer if it's fully clean.
        // If stdout has anything, it means there are changes (modified, staged, untracked, conflicts etc.)
        if (stdout.trim() === "") {
            return true;
        } else {
            // Optional: Log *why* it's not clean for better user feedback
            // console.warn(chalk.yellow("Git status details:\n" + stdout));
            return false;
        }
    } catch (error: any) {
        // If git status itself fails (e.g., not a git repo)
        console.error(chalk.red(`Failed to check git status for ${worktreePath}:`), error.stderr || error.message);
        // Treat failure to check as "not clean" or rethrow, depending on desired behavior.
        // Let's treat it as potentially unsafe to proceed.
        return false;
    }
}

// Add other git-related utilities here in the future

export async function isMainRepoBare(cwd: string = '.'): Promise<boolean> {
    try {
        // Find the root of the git repository
        const { stdout: gitDir } = await execa('git', ['-C', cwd, 'rev-parse', '--git-dir']);
        const mainRepoDir = gitDir.endsWith('/.git') ? gitDir.slice(0, -5) : gitDir; // Handle bare repo paths vs normal .git

        // Check the core.bare setting specifically for that repository path
        const { stdout: bareConfig } = await execa('git', ['config', '--get', '--bool', 'core.bare'], {
            cwd: mainRepoDir, // Check config in the main repo dir, not the potentially detached worktree CWD
        });

        // stdout will be 'true' or 'false' as a string
        return bareConfig.trim() === 'true';
    } catch (error: any) {
        // If the command fails (e.g., not a git repo, or config not set),
        // assume it's not bare, but log a warning.
        // A non-existent core.bare config defaults to false.
        if (error.exitCode === 1 && error.stdout === '' && error.stderr === '') {
            // This specific exit code/output means the config key doesn't exist, which is fine (defaults to false).
            return false;
        }
        console.warn(chalk.yellow(`Could not reliably determine if the main repository is bare. Proceeding cautiously. Error:`), error.stderr || error.message);
        return false; // Default to non-bare to avoid blocking unnecessarily, but warn the user.
    }
}

/**
 * Determine the name of the upstream remote for this repo instead of assuming
 * "origin". Prefers the remote that main/master actually tracks, then common
 * names, then the first configured remote, falling back to "origin".
 */
export async function getUpstreamRemote(cwd: string = "."): Promise<string> {
    try {
        // Strategy 1: derive the remote from main's (or master's) tracking ref,
        // e.g. refs/remotes/upstream/main -> "upstream".
        for (const localBranch of ["main", "master"]) {
            const { stdout } = await execa(
                "git",
                ["-C", cwd, "rev-parse", "--abbrev-ref", `${localBranch}@{upstream}`],
                { reject: false }
            );
            const match = stdout.trim().match(/^([^/]+)\//);
            if (match?.[1]) {
                return match[1];
            }
        }

        // Strategy 2: pick from the configured remotes, preferring common names.
        const { stdout: remotesOutput } = await execa("git", ["-C", cwd, "remote"]);
        const remotes = remotesOutput.split("\n").map(r => r.trim()).filter(Boolean);

        if (remotes.length === 0) {
            return "origin";
        }
        for (const common of ["origin", "upstream"]) {
            if (remotes.includes(common)) {
                return common;
            }
        }

        // Strategy 3: first available remote.
        return remotes[0];
    } catch {
        // If anything goes wrong, "origin" is the reasonable default.
        return "origin";
    }
}

/**
 * Determine whether `branchName` exists on any configured remote, and which
 * remote to use for it. Prefers the repo's default upstream remote, then any
 * other remote that has the branch — so fork setups (feature branches on
 * `origin`, `main` tracking `upstream`) resolve correctly instead of being
 * limited to a single guessed remote.
 */
export async function findRemoteBranch(
    branchName: string
): Promise<{ exists: boolean; remote: string }> {
    const preferred = await getUpstreamRemote();
    try {
        const { stdout: remotesRaw } = await execa("git", ["remote"]);
        const remotes = remotesRaw.split("\n").map(r => r.trim()).filter(Boolean);
        if (remotes.length === 0) {
            return { exists: false, remote: preferred };
        }

        const { stdout: refsRaw } = await execa("git", ["branch", "-r", "--format=%(refname:short)"]);
        const refSet = new Set(refsRaw.split("\n").map(r => r.trim()).filter(Boolean));

        // Check the preferred remote first, then the rest.
        const ordered = [preferred, ...remotes.filter(r => r !== preferred)];
        for (const r of ordered) {
            if (refSet.has(`${r}/${branchName}`)) {
                return { exists: true, remote: r };
            }
        }
        return { exists: false, remote: preferred };
    } catch {
        return { exists: false, remote: preferred };
    }
}

/**
 * Validate a git branch name against the subset of git's ref rules that are
 * cheap to check up front, so we fail with a clear message before invoking git.
 */
export function validateBranchName(branchName: string): { isValid: boolean; error?: string } {
    if (!branchName || branchName.trim() === "") {
        return { isValid: false, error: "Branch name cannot be empty" };
    }
    // A leading dash makes git parse the name as an option flag (arg injection).
    if (branchName.startsWith("-")) {
        return { isValid: false, error: 'Branch name cannot start with "-"' };
    }
    // Whitespace and the special characters git disallows in ref components.
    if (/[\s~^:?*[\]\\]/.test(branchName)) {
        return { isValid: false, error: "Branch name contains invalid characters" };
    }
    if (branchName.includes("..")) {
        return { isValid: false, error: 'Branch name cannot contain ".."' };
    }
    if (branchName.includes("@{")) {
        return { isValid: false, error: 'Branch name cannot contain "@{"' };
    }
    if (branchName.startsWith(".") || branchName.endsWith(".")) {
        return { isValid: false, error: 'Branch name cannot start or end with "."' };
    }
    if (branchName.startsWith("/") || branchName.endsWith("/")) {
        return { isValid: false, error: 'Branch name cannot start or end with "/"' };
    }
    if (branchName.endsWith(".lock")) {
        return { isValid: false, error: 'Branch name cannot end with ".lock"' };
    }
    return { isValid: true };
}

 