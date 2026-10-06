import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { confirm } from "@inquirer/prompts";
import { isMainRepoBare, isWorktreeClean, findRemoteBranch, validateBranchName } from "../utils/git.js";
import { finalizeWorktree } from "../utils/worktree.js";

export async function newWorktreeHandler(
    branchName: string = "main",
    options: { path?: string; checkout?: boolean; install?: string; editor?: string }
) {
    try {
        // 1. Validate we're in a git repo and resolve the repository root
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);
        const { stdout: repoRootStdout } = await execa("git", ["rev-parse", "--show-toplevel"]);
        const repoRoot = repoRootStdout.trim();

        const nameCheck = validateBranchName(branchName);
        if (!nameCheck.isValid) {
            console.error(chalk.red(`❌ Invalid branch name "${branchName}": ${nameCheck.error}`));
            process.exit(1);
        }

        // A dirty main worktree is fine: `git worktree add` checks out from the
        // committed HEAD and never touches the main worktree's changes. Just note it.
        if (!(await isWorktreeClean("."))) {
            console.log(chalk.yellow("⚠️  The current worktree has uncommitted changes (they'll be left untouched)."));
        }

        // 2. Build final path for the new worktree
        let folderName: string;
        if (options.path) {
            folderName = options.path;
        } else {
            // Derive the short name for the directory from the branch name
            // This handles cases like 'feature/login' -> 'login'
            const shortBranchName = branchName.split('/').filter(part => part.length > 0).pop() || branchName;

            const currentDir = process.cwd();
            const parentDir = dirname(currentDir);
            const currentDirName = basename(currentDir);
            // Create a sibling directory using the short branch name
            folderName = join(parentDir, `${currentDirName}-${shortBranchName}`);
        }
        const resolvedPath = resolve(folderName);

        // Check if directory already exists
        let directoryExists = false;
        try {
            await stat(resolvedPath);
            directoryExists = true;
        } catch (error) {
            // Directory doesn't exist, continue with creation
        }

        // 3. Check if branch exists locally or on any remote
        const { stdout: localBranchesRaw } = await execa("git", ["branch", "--list", branchName]);
        const localExists = !!localBranchesRaw.trim();
        // Only consult remotes when there's no local branch (avoids extra git subprocesses).
        const { exists: existsRemotely, remote } = localExists
            ? { exists: false, remote: "" }
            : await findRemoteBranch(branchName);
        const branchExists = localExists || existsRemotely;

        // 4. Create the new worktree or open the editor if it already exists
        if (directoryExists) {
            console.log(chalk.yellow(`Directory already exists at: ${resolvedPath}`));

            // Check if this is a git worktree by checking for .git file/folder
            let isGitWorktree = false;
            try {
                await stat(join(resolvedPath, ".git"));
                isGitWorktree = true;
            } catch (error) {
                // Not a git worktree
            }

            if (isGitWorktree) {
                console.log(chalk.green(`Using existing worktree at: ${resolvedPath}`));
            } else {
                console.log(chalk.yellow(`Warning: Directory exists but is not a git worktree.`));
            }

            // Skip to opening editor
        } else {
            console.log(chalk.blue(`Creating new worktree for branch "${branchName}" at: ${resolvedPath}`));

            if (await isMainRepoBare()) {
                console.error(chalk.red("❌ Error: The main repository is configured as 'bare' (core.bare=true)."));
                console.error(chalk.red("   This prevents normal Git operations. Please fix the configuration:"));
                console.error(chalk.cyan("   git config core.bare false"));
                process.exit(1);
            }

            if (!branchExists) {
                console.log(chalk.yellow(`Branch "${branchName}" doesn't exist. Creating new branch with worktree...`));
                // Create a new branch and worktree in one command with -b flag
                await execa("git", ["worktree", "add", "-b", branchName, resolvedPath]);
            } else if (!localExists && existsRemotely) {
                // Remote-only: create a local tracking branch from the remote that
                // actually has it (fork-aware) rather than relying on git's DWIM guess.
                console.log(chalk.yellow(`Branch "${branchName}" is remote-only. Creating local tracking branch...`));
                await execa("git", ["worktree", "add", "--track", "-b", branchName, resolvedPath, `${remote}/${branchName}`]);
            } else {
                console.log(chalk.yellow(`⚠️  Warning: Branch "${branchName}" already exists!`));
                console.log(chalk.yellow(`   This will check out the existing branch state, NOT create from current HEAD.`));
                const shouldContinue = await confirm({
                    message: "Do you want to continue and use the existing branch?",
                    default: false
                });

                if (!shouldContinue) {
                    console.log(chalk.blue("Operation cancelled. Please use a different branch name or delete the existing branch first."));
                    process.exit(0);
                }

                await execa("git", ["worktree", "add", resolvedPath, branchName]);
            }

            // 5. (Optional) Install dependencies if --install flag is provided
        }

        // finalizeWorktree copies extras, opens the editor (if any), announces
        // readiness + the `cd` command, then installs deps last (interruptible).
        await finalizeWorktree(repoRoot, resolvedPath, options);

    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to create new worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to create new worktree:"), error);
        }
        process.exit(1);
    }
} 
