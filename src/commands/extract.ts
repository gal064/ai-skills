import { execa } from "execa";
import chalk from "chalk";
import { stat } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { resolveEditor } from "../config.js";
import { isWorktreeClean, isMainRepoBare, getWorktreeList, findRemoteBranch, validateBranchName } from "../utils/git.js";
import { installDependencies } from "../utils/worktree.js";

export async function extractWorktreeHandler(
    branchName?: string,
    options: { path?: string; install?: string; editor?: string } = {}
) {
    try {
        // 1. Validate we're in a git repo
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        // 2. Determine which branch to extract
        let selectedBranch = branchName;
        if (!selectedBranch) {
            // Get current branch if no branch specified
            const { stdout: currentBranch } = await execa("git", ["branch", "--show-current"]);
            selectedBranch = currentBranch.trim();

            if (!selectedBranch) {
                console.error(chalk.red("❌ Error: Could not determine current branch (possibly in detached HEAD state)."));
                console.error(chalk.yellow("Please specify a branch name: gdev wt extract <branch-name>"));
                process.exit(1);
            }

            console.log(chalk.blue(`No branch specified. Using current branch: ${selectedBranch}`));
        }

        const nameCheck = validateBranchName(selectedBranch);
        if (!nameCheck.isValid) {
            console.error(chalk.red(`❌ Invalid branch name "${selectedBranch}": ${nameCheck.error}`));
            process.exit(1);
        }

        // A dirty main worktree is fine: `git worktree add` checks out from the
        // committed branch state and never touches the main worktree's changes.
        if (!(await isWorktreeClean("."))) {
            console.log(chalk.yellow("⚠️  The current worktree has uncommitted changes (they'll be left untouched)."));
        }

        // 3. Get existing worktrees to check if branch already has one
        const worktrees = await getWorktreeList();
        const worktreeBranches = worktrees
            .map(wt => wt.branch)
            .filter((b): b is string => b !== null);
        
        if (worktreeBranches.includes(selectedBranch)) {
            console.error(chalk.red(`❌ Error: Branch "${selectedBranch}" already has a worktree.`));
            console.error(chalk.yellow("Use 'gdev wt list' to see existing worktrees."));
            process.exit(1);
        }

        // 4. Verify the branch exists (either locally or on any remote)
        const { stdout: localBranches } = await execa("git", ["branch", "--format=%(refname:short)"]);
        const localBranchList = localBranches.split('\n').filter(b => b.trim() !== '');
        const branchExistsLocally = localBranchList.includes(selectedBranch);

        // `remote` is the remote that actually has the branch (fork-aware), used
        // below to create the tracking branch from the correct ref. Only consult
        // remotes when there's no local branch (avoids extra git subprocesses).
        const { exists: branchExistsRemotely, remote } = branchExistsLocally
            ? { exists: false, remote: "" }
            : await findRemoteBranch(selectedBranch);
        
        if (!branchExistsLocally && !branchExistsRemotely) {
            console.error(chalk.red(`❌ Error: Branch "${selectedBranch}" does not exist locally or remotely.`));
            process.exit(1);
        }

        // 5. Build final path for the new worktree
        let folderName: string;
        if (options.path) {
            folderName = options.path;
        } else {
            // Derive the short name for the directory from the branch name
            const shortBranchName = selectedBranch.split('/').filter(part => part.length > 0).pop() || selectedBranch;
            
            const currentDir = process.cwd();
            const parentDir = dirname(currentDir);
            const currentDirName = basename(currentDir);
            // Create a sibling directory using the short branch name
            folderName = join(parentDir, `${currentDirName}-${shortBranchName}`);
        }
        const resolvedPath = resolve(folderName);

        // Check if directory already exists
        try {
            await stat(resolvedPath);
            console.error(chalk.red(`❌ Error: Directory already exists at: ${resolvedPath}`));
            console.error(chalk.yellow("Please choose a different path with --path option."));
            process.exit(1);
        } catch (error) {
            // Directory doesn't exist, continue with creation
        }

        // 6. Check if this is a bare repository
        if (await isMainRepoBare()) {
            console.error(chalk.red("❌ Error: The main repository is configured as 'bare' (core.bare=true)."));
            console.error(chalk.red("   This prevents normal Git operations. Please fix the configuration:"));
            console.error(chalk.cyan("   git config core.bare false"));
            process.exit(1);
        }

        // 7. Create the worktree
        console.log(chalk.blue(`Extracting branch "${selectedBranch}" to worktree at: ${resolvedPath}`));

        // Check if we need to create a tracking branch first (if it's only remote)
        if (!branchExistsLocally && branchExistsRemotely) {
            console.log(chalk.yellow(`Branch "${selectedBranch}" is remote-only. Creating local tracking branch...`));
            await execa("git", ["worktree", "add", "--track", "-b", selectedBranch, resolvedPath, `${remote}/${selectedBranch}`]);
        } else {
            // Branch exists locally
            await execa("git", ["worktree", "add", resolvedPath, selectedBranch]);
        }

        console.log(chalk.green(`✅ Successfully extracted branch "${selectedBranch}" to worktree.`));

        // 8. Open the editor (if one is configured) before installing.
        const editorCommand = resolveEditor(options.editor);
        if (editorCommand) {
            console.log(chalk.blue(`Opening ${resolvedPath} in ${editorCommand}...`));
            try {
                await execa(editorCommand, [resolvedPath], { stdio: "inherit" });
            } catch (editorError) {
                console.error(chalk.red(`Failed to open editor "${editorCommand}". Please ensure it's installed and in your PATH.`));
                console.warn(chalk.yellow(`Continuing without opening editor.`));
            }
        }

        // 9. Announce readiness before the (Ctrl+C-interruptible) install.
        console.log(chalk.green(`\n✅ Worktree extracted at ${resolvedPath}.`));

        // 10. Install dependencies last.
        await installDependencies(resolvedPath, options.install);

    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to extract worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to extract worktree:"), error);
        }
        process.exit(1);
    }
}