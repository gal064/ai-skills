import { execa } from "execa";
import chalk from "chalk";
import { stat, rm } from "node:fs/promises";
import { confirm, select } from "@inquirer/prompts";
import {
    isMainRepoBare,
    getWorktreeList,
    findWorktreeByBranch,
    findWorktreeByPath,
    type WorktreeEntry,
} from "../utils/git.js";

function worktreeLabel(wt: WorktreeEntry): string {
    if (wt.branch) return `${wt.branch}  (${wt.path})`;
    return `(detached ${wt.head.substring(0, 8)})  (${wt.path})`;
}

export async function removeWorktreeHandler(
    pathOrBranch: string = "",
    options: { force?: boolean }
) {
    try {
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        let targetWorktree: WorktreeEntry | null = null;

        if (!pathOrBranch) {
            // No argument: let the user pick from the removable worktrees.
            if (!process.stdin.isTTY) {
                console.error(chalk.red("A worktree path or branch is required in non-interactive mode."));
                console.error(chalk.yellow("Run 'gdev wt remove <pathOrBranch>', or use an interactive terminal to pick one."));
                process.exit(1);
            }

            const worktrees = await getWorktreeList();
            const removable = worktrees.filter(wt => !wt.isMain);

            if (removable.length === 0) {
                console.log(chalk.yellow("No worktrees available to remove (only the main worktree exists)."));
                process.exit(0);
            }

            targetWorktree = await select({
                message: "Select a worktree to remove",
                choices: removable.map(wt => ({ name: worktreeLabel(wt), value: wt })),
            });
        } else {
            // Resolve by path first, then by branch. Path lookup compares the
            // recorded worktree paths, so it still matches a stale worktree whose
            // directory has been deleted (which the branch lookup can't catch).
            targetWorktree = await findWorktreeByPath(pathOrBranch);
            if (!targetWorktree) {
                targetWorktree = await findWorktreeByBranch(pathOrBranch);
            }

            if (!targetWorktree) {
                console.error(chalk.red(`Could not find a worktree for "${pathOrBranch}".`));
                console.error(
                    chalk.yellow("Run 'gdev wt list' to see existing worktrees, or 'gdev wt remove' with no argument to pick one.")
                );
                process.exit(1);
            }
        }

        const targetPath = targetWorktree.path;

        // Never remove the main worktree.
        if (targetWorktree.isMain) {
            console.error(chalk.red("Cannot remove the main worktree."));
            process.exit(1);
        }

        console.log(chalk.blue("Worktree to remove:"));
        if (targetWorktree.branch) {
            console.log(chalk.cyan(`  Branch: ${targetWorktree.branch}`));
        }
        console.log(chalk.cyan(`  Path:   ${targetPath}`));

        // Locked worktrees require --force.
        if (targetWorktree.locked) {
            console.log(
                chalk.yellow(
                    `  Warning: this worktree is locked${targetWorktree.lockReason ? `: ${targetWorktree.lockReason}` : ""}.`
                )
            );
            if (!options.force) {
                console.error(chalk.red("Use --force to remove a locked worktree."));
                process.exit(1);
            }
        }

        // Confirm unless forced or running non-interactively.
        const isNonInteractive = !process.stdin.isTTY;
        if (!options.force && !isNonInteractive) {
            const confirmed = await confirm({
                message: "Are you sure you want to remove this worktree?",
                default: false,
            });
            if (!confirmed) {
                console.log(chalk.yellow("Removal cancelled."));
                process.exit(0);
            }
        }

        if (await isMainRepoBare()) {
            console.error(chalk.red("❌ Error: The main repository is configured as 'bare' (core.bare=true)."));
            console.error(chalk.red("   This prevents normal Git operations. Please fix the configuration:"));
            console.error(chalk.cyan("   git config core.bare false"));
            process.exit(1);
        }

        // A locked worktree needs a second --force for git to remove it
        // ("-f -f" overrides the lock); a plain dirty worktree needs one.
        const forceFlags = options.force
            ? (targetWorktree.locked ? ["--force", "--force"] : ["--force"])
            : [];

        // Remove the worktree metadata, with a recovery prompt if git refuses
        // because of modified/untracked files.
        console.log(chalk.blue(`Removing worktree: ${targetPath}`));
        try {
            await execa("git", ["worktree", "remove", ...forceFlags, targetPath]);
        } catch (removeError: any) {
            const stderr = removeError?.stderr || "";
            if (stderr.includes("modified or untracked files") && !options.force) {
                console.log(chalk.yellow("Worktree contains modified or untracked files."));
                if (!process.stdin.isTTY) {
                    console.error(chalk.red("Refusing to remove a dirty worktree without --force in non-interactive mode."));
                    console.error(chalk.yellow("Re-run with --force to remove it and discard those changes."));
                    process.exit(1);
                }
                const forceRemove = await confirm({
                    message: "Force remove this worktree? This may lose those changes.",
                    default: false,
                });
                if (!forceRemove) {
                    console.log(chalk.yellow("Removal cancelled."));
                    process.exit(0);
                }
                await execa("git", ["worktree", "remove", "--force", targetPath]);
            } else {
                throw removeError;
            }
        }

        // Remove the physical directory if it still exists.
        try {
            await stat(targetPath);
            await rm(targetPath, { recursive: true, force: true });
            console.log(chalk.green(`Deleted folder ${targetPath}`));
        } catch {
            // Directory doesn't exist, which is fine
        }
        console.log(chalk.green("Worktree removed successfully!"));
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Failed to remove worktree:"), error.message);
        } else {
            console.error(chalk.red("Failed to remove worktree:"), error);
        }
        process.exit(1);
    }
}
