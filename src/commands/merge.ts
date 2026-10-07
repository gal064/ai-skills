import { execa } from "execa";
import chalk from "chalk";
import { stat, rm } from "node:fs/promises";
import { isMainRepoBare, isWorktreeClean, getWorktreeList } from "../utils/git.js";

export async function mergeWorktreeHandler(
    branchName: string,
    options: {
        force?: boolean;
        autoCommit?: boolean;
        message?: string;
        remove?: boolean;
    }
) {
    try {
        // Validate that we're in a git repository
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        // -m/-f only apply to the --auto-commit / --remove paths respectively;
        // warn so they aren't silently ignored.
        if (options.message && !options.autoCommit) {
            console.log(chalk.yellow("Note: --message is only used with --auto-commit; ignoring it."));
        }
        if (options.force && !options.remove) {
            console.log(chalk.yellow("Note: --force only applies with --remove; ignoring it."));
        }

        // Get the current branch name (the target for merging)
        const { stdout: currentBranch } = await execa("git", ["branch", "--show-current"]);
        if (!currentBranch) {
            console.error(chalk.red("Failed to determine the current branch."));
            process.exit(1);
        }

        // Find the worktree for the target branch
        const worktrees = await getWorktreeList();
        const match = worktrees.find(wt => wt.branch === branchName);
        const targetPath = match?.path || "";

        if (!targetPath) {
            console.error(chalk.red(`Could not find a worktree for branch "${branchName}".`));
            process.exit(1);
        }

        // Guard early: --remove on the main worktree would merge and then fail
        // at removal. Reject before doing anything.
        if (options.remove && match?.isMain) {
            console.error(chalk.red(`Refusing to remove the main worktree for branch "${branchName}".`));
            console.error(chalk.yellow("Re-run without --remove."));
            process.exit(1);
        }

        console.log(
            chalk.blue(
                `Merging changes from worktree branch "${branchName}" at ${targetPath} into current branch "${currentBranch}".`
            )
        );

        // Step 1: Handle uncommitted changes in the target worktree.
        // By default we refuse to touch a dirty branch; --auto-commit opts in to
        // committing those changes (with an optional custom message) first.
        const isClean = await isWorktreeClean(targetPath);

        if (!isClean && !options.autoCommit) {
            console.error(
                chalk.red(`Error: The target worktree for branch "${branchName}" has uncommitted changes.`)
            );
            console.error(
                chalk.yellow("Commit or stash them first, or pass --auto-commit to commit them automatically.")
            );
            process.exit(1);
        }

        if (options.autoCommit && !isClean) {
            // --auto-commit was explicitly requested and we know there are
            // changes, so a commit failure (hook rejection, signing error, …)
            // is fatal — merging without the changes would silently drop them.
            try {
                await execa("git", ["-C", targetPath, "add", "."]);
                const commitMessage = options.message || `Auto-commit changes before merging ${branchName}`;
                await execa("git", ["-C", targetPath, "commit", "-m", commitMessage]);
                console.log(chalk.green("Committed pending changes in target branch worktree."));
            } catch (commitError: any) {
                console.error(
                    chalk.red(`Failed to auto-commit changes in the target worktree for "${branchName}".`)
                );
                console.error(chalk.yellow(commitError?.stderr || commitError?.message || String(commitError)));
                console.error(chalk.yellow("Aborting the merge; your changes are untouched."));
                process.exit(1);
            }
        }

        // Step 2: Merge the target branch into the current branch
        console.log(chalk.blue(`Merging branch "${branchName}" into "${currentBranch}"...`));
        await execa("git", ["merge", branchName]);
        console.log(chalk.green(`Merged branch "${branchName}" into "${currentBranch}".`));

        // Step 3: Only remove the worktree when explicitly requested. By default
        // the worktree is preserved so a merge is non-destructive.
        if (options.remove) {
            console.log(chalk.blue(`Removing worktree for branch "${branchName}"...`));

            if (await isMainRepoBare()) {
                console.error(chalk.red("❌ Error: The main repository is configured as 'bare' (core.bare=true)."));
                console.error(chalk.red("   This prevents normal Git operations. Please fix the configuration:"));
                console.error(chalk.cyan("   git config core.bare false"));
                process.exit(1);
            }

            const removeArgs = ["worktree", "remove", ...(options.force ? ["--force"] : []), targetPath];
            await execa("git", removeArgs);
            console.log(chalk.green(`Removed worktree at ${targetPath}.`));

            // Optionally remove the physical directory if it still exists
            try {
                await stat(targetPath);
                await rm(targetPath, { recursive: true, force: true });
                console.log(chalk.green(`Deleted folder ${targetPath}.`));
            } catch {
                // If the directory does not exist, it's fine
            }
        } else {
            console.log(chalk.blue(`Worktree for branch "${branchName}" at ${targetPath} has been preserved.`));
            console.log(chalk.yellow(`Run 'gdev remove ${branchName}' to clean it up when ready.`));
        }

        console.log(chalk.green("Merge command completed successfully!"));
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to merge worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to merge worktree:"), error);
        }
        process.exit(1);
    }
}
