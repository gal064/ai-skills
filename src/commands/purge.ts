import { execa, ExecaError } from "execa";
import chalk from "chalk";
import { stat, rm } from "node:fs/promises";
import readline from "node:readline";
import { getWorktreeList, type WorktreeEntry } from "../utils/git.js";

// Utility function for interactive confirmation
function askQuestion(query: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => rl.question(query, (ans) => {
        rl.close();
        resolve(ans);
    }));
}

function getWorktreeLabel(wt: WorktreeEntry): string {
    if (wt.branch) return `branch "${wt.branch}"`;
    return `detached HEAD (${wt.head.substring(0, 8)})`;
}

function getWorktreeDisplayLine(wt: WorktreeEntry): string {
    const label = getWorktreeLabel(wt);
    const prunableTag = wt.isPrunable ? chalk.red(" [prunable]") : "";
    return `${label} at path "${wt.path}"${prunableTag}`;
}

export async function purgeWorktreesHandler() {
    try {
        const allWorktrees = await getWorktreeList();

        if (allWorktrees.length === 0) {
            console.log(chalk.yellow("No worktrees found."));
            return;
        }

        // First entry is always the base worktree (repo root) — never purge it
        const [, ...linkedWorktrees] = allWorktrees;

        // Include everything except non-prunable main branch worktrees
        const purgeWorktrees = linkedWorktrees.filter((wt) => {
            if (wt.isPrunable) return true;
            if (wt.branch === "main") return false;
            return true;
        });

        if (purgeWorktrees.length === 0) {
            console.log(chalk.green("No worktrees to purge."));
            return;
        }

        console.log(chalk.blue(`Found ${purgeWorktrees.length} worktree(s) to potentially purge:`));

        // Loop through each worktree and ask for confirmation before removal
        for (const wt of purgeWorktrees) {
            console.log(chalk.blue(`Worktree: ${getWorktreeDisplayLine(wt)}`));
            const answer = await askQuestion(`Do you want to remove this worktree? (y/N): `);
            if (answer.toLowerCase() === "y") {
                // Locked worktrees require an explicit extra confirmation and a
                // forced removal, since 'git worktree remove' refuses them.
                let forceLocked = false;
                if (wt.locked) {
                    console.log(
                        chalk.yellow(
                            `This worktree is locked${wt.lockReason ? `: ${wt.lockReason}` : ""}.`
                        )
                    );
                    const lockedAnswer = await askQuestion(`It is locked. Force remove it anyway? (y/N): `);
                    if (lockedAnswer.toLowerCase() !== "y") {
                        console.log(chalk.yellow(`Skipping locked worktree ${getWorktreeLabel(wt)}.`));
                        continue;
                    }
                    forceLocked = true;
                }

                console.log(chalk.blue(`Removing worktree for ${getWorktreeLabel(wt)}...`));
                let removedSuccessfully = false; // Flag to track successful removal
                try {
                    // Remove worktree using Git. A locked worktree needs "-f -f"
                    // (a second --force) for git to override the lock.
                    await execa("git", ["worktree", "remove", ...(forceLocked ? ["--force", "--force"] : []), wt.path]);
                    console.log(chalk.green(`Removed worktree metadata for ${wt.path}.`));
                    removedSuccessfully = true; // Mark as successfully removed by git command

                } catch (removeError: unknown) { // Catch potential errors
                    const execaError = removeError as ExecaError; // Type assertion
                    const stderr = execaError?.stderr || '';
                    const message = execaError?.message || String(removeError);

                    // --- Enhanced Error Handling ---

                    if (stderr.includes("modified or untracked files")) {
                        // Specific handling for dirty worktrees
                        console.log(chalk.yellow(`Worktree contains modified or untracked files.`));
                        const forceAnswer = await askQuestion(`Do you want to force remove this worktree (this may lose changes)? (y/N): `);
                        if (forceAnswer.toLowerCase() === "y") {
                            try {
                                await execa("git", ["worktree", "remove", "--force", wt.path]);
                                console.log(chalk.green(`Force removed worktree metadata for ${wt.path}.`));
                                removedSuccessfully = true; // Mark as successfully removed by git command
                            } catch (forceError: unknown) {
                                const forceExecaError = forceError as ExecaError;
                                console.error(chalk.red(`Failed to force remove worktree metadata for ${getWorktreeLabel(wt)}:`), forceExecaError.stderr || forceExecaError.message);
                                // Do not attempt rm -rf if even force remove failed
                            }
                        } else {
                            console.log(chalk.yellow(`Skipping removal for worktree ${getWorktreeLabel(wt)}.`));
                            // continue; // Skip to next worktree if not forcing
                        }
                    } else if (stderr.includes("fatal: validation failed") && stderr.includes("is not a .git file")) {
                        // Specific handling for the validation error
                        console.error(chalk.red(`❌ Error removing worktree for ${getWorktreeLabel(wt)} at "${wt.path}".`));
                        console.error(chalk.red(`   Git detected an inconsistency: The directory exists, but its '.git' file is missing, corrupted, or not what Git expected.`));
                        console.error(chalk.yellow(`   This means the worktree metadata in your main repo points to a directory that isn't a valid linked worktree anymore.`));
                        console.log(chalk.cyan(`   Suggested next steps:`));
                        console.log(chalk.cyan(`     1. Try running 'git worktree prune' in your main repository directory. This might clean up the stale metadata.`));
                        console.log(chalk.cyan(`     2. Manually inspect the directory: 'ls -la "${wt.path}/.git"'`));
                        console.log(chalk.cyan(`     3. If you are CERTAIN you don't need the contents, you might need to manually delete the directory: 'rm -rf "${wt.path}"'`));
                        console.log(chalk.cyan(`        (Do this AFTER trying 'git worktree prune' if possible).`));
                        console.log(chalk.yellow(`   Skipping automatic folder deletion for this inconsistent worktree.`));
                        // Do not set removedSuccessfully = true
                        // Do not attempt rm -rf below for this case

                    } else {
                        // Generic error handling for other 'git worktree remove' failures
                        console.error(chalk.red(`Failed to remove worktree metadata for ${getWorktreeLabel(wt)}:`), stderr || message);
                        // Do not attempt rm -rf if git remove failed unexpectedly
                    }
                } // End of inner try-catch for git worktree remove

                // --- Optional Folder Deletion (Only if Git remove succeeded) ---
                if (removedSuccessfully) {
                    // Optionally remove the physical directory if it still exists *after* git remove succeeded
                    try {
                        await stat(wt.path); // Check if directory still exists
                        console.log(chalk.blue(`Attempting to delete folder ${wt.path}...`));
                        await rm(wt.path, { recursive: true, force: true });
                        console.log(chalk.green(`Deleted folder ${wt.path}.`));
                    } catch (statError: any) {
                        // If stat fails with 'ENOENT', the directory doesn't exist, which is fine.
                        if (statError.code !== 'ENOENT') {
                            console.warn(chalk.yellow(`Could not check or delete folder ${wt.path}: ${statError.message}`));
                        } else {
                            // Directory already gone, maybe git remove --force deleted it, or it was never there
                            console.log(chalk.grey(`Folder ${wt.path} does not exist or was already removed.`));
                        }
                    }
                } else {
                    console.log(chalk.yellow(`Skipping folder deletion for "${wt.path}" because Git worktree removal did not complete successfully.`));
                }

            } else {
                console.log(chalk.yellow(`Skipping removal for worktree ${getWorktreeLabel(wt)}.`));
            }
        } // End of for loop

        console.log(chalk.green("Purge command finished."));
    } catch (error) { // Outer catch for initial git worktree list or other setup errors
        if (error instanceof Error) {
            console.error(chalk.red("Failed during purge operation:"), error.message);
        } else {
            console.error(chalk.red("Failed during purge operation:"), error);
        }
        process.exit(1);
    }
} 