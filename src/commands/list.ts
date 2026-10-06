import { execa } from "execa";
import chalk from "chalk";

export async function listWorktreesHandler() {
    try {
        // Confirm we're in a git repo
        await execa("git", ["rev-parse", "--is-inside-work-tree"]);

        // List worktrees
        const { stdout } = await execa("git", ["worktree", "list"]);
        console.log(chalk.blue("Existing worktrees:\n"));
        console.log(stdout);
    } catch (error) {
        if (error instanceof Error) {
            console.error(chalk.red("Error listing worktrees:"), error.message);
        } else {
            console.error(chalk.red("Error listing worktrees:"), error);
        }
        process.exit(1);
    }
} 