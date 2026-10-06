import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { confirm } from "@inquirer/prompts";
import { isMainRepoBare, findRemoteBranch, validateBranchName } from "../utils/git.js";
import {
    replicateWorkingTreeState,
    duplicateGitIndex,
    finalizeWorktree,
} from "../utils/worktree.js";

interface CopyOptions {
    path?: string;
    install?: string;
    editor?: string;
}

function generateBranchName(currentBranch: string | null): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "");
    const base = (currentBranch && currentBranch.length > 0 ? currentBranch : "detached").replace(
        /[^a-zA-Z0-9._/-]+/g,
        "-"
    );
    return `copy/${base}-${timestamp}`;
}

export async function copyWorktreeHandler(
    branchName?: string,
    options: CopyOptions = {}
) {
    try {
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);
        const { stdout: repoRootStdout } = await execa("git", ["rev-parse", "--show-toplevel"]);
        const repoRoot = repoRootStdout.trim();

        const { stdout: currentBranchStdout } = await execa("git", ["branch", "--show-current"]);
        const currentBranch = currentBranchStdout.trim() || null;

        let targetBranch = branchName?.trim();
        if (!targetBranch) {
            targetBranch = generateBranchName(currentBranch);
            console.log(chalk.blue(`No branch specified. Using generated branch name: ${targetBranch}`));
        } else {
            const nameCheck = validateBranchName(targetBranch);
            if (!nameCheck.isValid) {
                console.error(chalk.red(`❌ Invalid branch name "${targetBranch}": ${nameCheck.error}`));
                process.exit(1);
            }
        }

        let folderName: string;
        if (options.path) {
            folderName = options.path;
        } else {
            const shortBranchName = targetBranch
                .split("/")
                .filter((part) => part.length > 0)
                .pop() || targetBranch;

            const currentDir = process.cwd();
            const parentDir = dirname(currentDir);
            const currentDirName = basename(currentDir);
            folderName = join(parentDir, `${currentDirName}-${shortBranchName}`);
        }
        const resolvedPath = resolve(folderName);

        try {
            await stat(resolvedPath);
            console.error(chalk.red(`❌ Error: Directory already exists at: ${resolvedPath}`));
            console.error(chalk.yellow("Please choose a different path with --path option."));
            process.exit(1);
        } catch (error) {
            // Directory doesn't exist, continue
        }

        if (await isMainRepoBare()) {
            console.error(chalk.red("❌ Error: The main repository is configured as 'bare' (core.bare=true)."));
            console.error(chalk.red("   This prevents normal Git operations. Please fix the configuration:"));
            console.error(chalk.cyan("   git config core.bare false"));
            process.exit(1);
        }

        const { stdout: localBranches } = await execa("git", ["branch", "--list", targetBranch]);
        const localExists = localBranches.trim().length > 0;
        // Only consult remotes when there's no local branch (avoids extra git subprocesses).
        const { exists: existsRemotely, remote } = localExists
            ? { exists: false, remote: "" }
            : await findRemoteBranch(targetBranch);
        const branchExists = localExists || existsRemotely;

        console.log(chalk.blue(`Creating copy worktree at: ${resolvedPath}`));
        if (!branchExists) {
            console.log(chalk.blue(`Creating new branch "${targetBranch}" from current HEAD.`));
            await execa("git", ["worktree", "add", "-b", targetBranch, resolvedPath, "HEAD"]);
        } else if (!localExists && existsRemotely) {
            // Remote-only: create a local tracking branch from the remote that
            // actually has it (fork-aware), then overwrite with the working tree below.
            console.log(chalk.yellow(`Branch "${targetBranch}" is remote-only. Creating local tracking branch...`));
            console.log(chalk.yellow(`   It will then be overwritten with your current working tree state.`));
            await execa("git", ["worktree", "add", "--track", "-b", targetBranch, resolvedPath, `${remote}/${targetBranch}`]);
        } else {
            console.log(chalk.yellow(`⚠️  Warning: Branch "${targetBranch}" already exists!`));
            console.log(chalk.yellow(`   This will check out the existing branch, then overwrite with your current working tree state.`));
            const shouldContinue = await confirm({
                message: "Do you want to continue with the existing branch?",
                default: false
            });

            if (!shouldContinue) {
                console.log(chalk.blue("Operation cancelled. Please use a different branch name or delete the existing branch first."));
                process.exit(0);
            }

            await execa("git", ["worktree", "add", resolvedPath, targetBranch]);
        }

        await replicateWorkingTreeState(repoRoot, resolvedPath);
        await duplicateGitIndex(repoRoot, resolvedPath);
        // git update-index --refresh exits with code 1 when files have stale stat
        // info (e.g. different timestamps after copying), which is expected here.
        await execa("git", ["update-index", "--refresh"], { cwd: resolvedPath, reject: false });

        console.log(chalk.green(`Branch ready at ${targetBranch}.`));
        // finalizeWorktree copies extras, opens the editor (if any), announces
        // readiness + the `cd` command, then installs deps last (interruptible).
        await finalizeWorktree(repoRoot, resolvedPath, options);
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to create copy worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to create copy worktree:"), error);
        }
        process.exit(1);
    }
}
