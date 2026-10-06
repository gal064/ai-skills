#!/usr/bin/env node

import { Command } from "commander";
import { newWorktreeHandler } from "./commands/new.js";
import { copyWorktreeHandler } from "./commands/copy.js";
import { listWorktreesHandler } from "./commands/list.js";
import { removeWorktreeHandler } from "./commands/remove.js";
import { mergeWorktreeHandler } from "./commands/merge.js";
import { purgeWorktreesHandler } from "./commands/purge.js";
import { configHandler } from "./commands/config.js";
import { prWorktreeHandler } from "./commands/pr.js";
import { openWorktreeHandler } from "./commands/open.js";
import { extractWorktreeHandler } from "./commands/extract.js";
import { setupConfigs } from "./commands/setup.js";
import { getDefaultPackageManager } from "./config.js";

/**
 * Resolves the install option based on CLI flag and config.
 * Priority: CLI flag > config
 */
function resolveInstallOption(cliValue: string | boolean | undefined): string | undefined {
  if (cliValue !== undefined) {
    if (typeof cliValue === 'boolean') {
      return cliValue ? 'auto' : undefined;
    }
    return cliValue;
  }
  const configValue = getDefaultPackageManager();
  return configValue === 'skip' ? 'skip' : configValue;
}

const program = new Command();

program
  .name("gdev")
  .description("AI agent setup and git worktrees.")
  .version("1.0.0");

program
  .command("setup")
  .description("Install Ghostty and/or AI-agent configuration bundles.")
  .option("--terminal", "Install the Ghostty config and SSH truecolor block")
  .option("--ai <agents>", "Configure comma-separated agents: claude,codex")
  .option("--skills <agents>", "Install all repository skills for claude,codex")
  .option("--memory <agents>", "Install shared global instructions for claude,codex")
  .option("--aliases", "Install the shell aliases from configs/shell/ai-aliases.sh")
  .option("--relaxed-permissions", "auto-approve the managed Claude/Codex command policy")
  .option("--revoke-relaxed-permissions", "remove approvals previously installed by gdev setup")
  .option("--unsafe-mode", "Hide Claude's dangerous-mode warning prompt")
  .option("--remote-control <agents>", "Enable remote behavior for claude,codex")
  .option("--disable-codex-skills", "Disable Codex-provided skills except ImageGen, OpenAI Docs, and Sites")
  .option("--codex-extended-context", "Set Codex context to 400,000 tokens and auto-compact at 360,000")
  .option("--no-codex-extended-context", "Remove the matching Codex 400,000/360,000 context override")
  .option("--codex-max-subagents", "Set the Codex concurrent subagent limit to 10")
  .option("--no-codex-max-subagents", "Preserve the existing Codex concurrent subagent limit")
  .option("-y, --yes", "Apply the explicit selection without confirmation")
  .action((options) => setupConfigs(options));

// --- Subcommand group: git worktree management ---

const wt = program
  .command("wt")
  .description("Git worktree management.");

wt
  .command("new")
  .argument("[branchName]", "Name of the branch to base this worktree on")
  .option("-p, --path <path>", "Relative path/folder name for new worktree")
  .option(
    "-c, --checkout",
    "Create new branch if it doesn't exist and checkout automatically",
    false
  )
  .option(
    "-i, --install [packageManager]",
    "Package manager to use for installing dependencies (npm, pnpm, bun, uv, skip, auto, etc.). If no value provided, auto-detects."
  )
  .option(
    "-e, --editor <editor>",
    "Editor to use for opening the worktree (e.g., code, webstorm, windsurf, etc.)"
  )
  .description(
    "Create a new worktree for the specified branch, install dependencies if specified, and open in editor."
  )
  .action((branchName, options) => {
    const resolvedInstall = resolveInstallOption(options.install);
    newWorktreeHandler(branchName, { ...options, install: resolvedInstall });
  });

wt
  .command("copy")
  .argument("[branchName]", "Name of the branch to create or reuse for the copied worktree")
  .option("-p, --path <path>", "Relative path/folder name for the new worktree")
  .option(
    "-i, --install [packageManager]",
    "Package manager to use for installing dependencies (npm, pnpm, bun, uv, skip, auto, etc.). If no value provided, auto-detects."
  )
  .option(
    "-e, --editor <editor>",
    "Editor to use for opening the worktree (e.g., code, webstorm, windsurf, etc.)"
  )
  .description(
    "Create a new worktree from the current HEAD and replicate the working directory state."
  )
  .action((branchName, options) => {
    const resolvedInstall = resolveInstallOption(options.install);
    copyWorktreeHandler(branchName, { ...options, install: resolvedInstall });
  });

wt
  .command("list")
  .alias("ls")
  .description("List all existing worktrees for this repository.")
  .action(listWorktreesHandler);

wt
  .command("remove")
  .alias("rm")
  .argument("[pathOrBranch]", "Path of the worktree or branch to remove.")
  .option(
    "-f, --force",
    "Force removal of worktree and deletion of the folder",
    false
  )
  .description(
    "Remove a specified worktree. Cleans up the .git/worktrees references."
  )
  .action(removeWorktreeHandler);

wt
  .command("merge")
  .argument("<branchName>", "Name of the branch to merge from")
  .option("--auto-commit", "Commit uncommitted changes in the target branch before merging", false)
  .option("-m, --message <message>", "Commit message to use with --auto-commit")
  .option("--remove", "Remove the source worktree after a successful merge", false)
  .option("-f, --force", "Force worktree removal (only applies with --remove)", false)
  .description(
    "Merge a worktree branch into the current branch. Refuses a dirty target unless --auto-commit; preserves the worktree unless --remove."
  )
  .action(mergeWorktreeHandler);

wt
  .command("purge")
  .description(
    "Safely remove all worktrees except for the main branch, with confirmation."
  )
  .action(purgeWorktreesHandler);

wt
  .command("pr")
  .argument(
    "<prNumber>",
    "GitHub Pull Request number to create a worktree from"
  )
  .option(
    "-p, --path <path>",
    "Specify a custom path for the worktree (defaults to repoName-branchName)"
  )
  .option(
    "-i, --install [packageManager]",
    "Package manager to use for installing dependencies (npm, pnpm, bun, uv, skip, auto, etc.). If no value provided, auto-detects."
  )
  .option(
    "-e, --editor <editor>",
    "Editor to use for opening the worktree (overrides default editor)"
  )
  .description(
    "Fetch the branch for a given GitHub PR number and create a worktree."
  )
  .action((prNumber, options) => {
    const resolvedInstall = resolveInstallOption(options.install);
    prWorktreeHandler(prNumber, { ...options, install: resolvedInstall });
  });

wt
  .command("open")
  .argument("[pathOrBranch]", "Path to worktree or branch name to open")
  .option(
    "-e, --editor <editor>",
    "Editor to use for opening the worktree (overrides default editor)"
  )
  .description("Open an existing worktree in the editor.")
  .action(openWorktreeHandler);

wt
  .command("extract")
  .argument("[branchName]", "Name of the branch to extract (defaults to current branch)")
  .option("-p, --path <path>", "Relative path/folder name for the worktree")
  .option(
    "-i, --install [packageManager]",
    "Package manager to use for installing dependencies (npm, pnpm, bun, uv, skip, auto, etc.). If no value provided, auto-detects."
  )
  .option(
    "-e, --editor <editor>",
    "Editor to use for opening the worktree (overrides default editor)"
  )
  .description(
    "Extract an existing branch as a new worktree. If no branch is specified, extracts the current branch."
  )
  .action((branchName, options) => {
    const resolvedInstall = resolveInstallOption(options.install);
    extractWorktreeHandler(branchName, { ...options, install: resolvedInstall });
  });

wt
  .command("config")
  .description("Manage CLI configuration settings.")
  .addCommand(
    new Command("set")
      .description("Set a configuration value.")
      .addCommand(
        new Command("editor")
          .argument(
            "<editorName>",
            "Name of the editor command (e.g., code, cursor, webstorm)"
          )
          .description("Set the default editor to open worktrees in.")
          .action((editorName) => configHandler("set", "editor", editorName))
      )
      .addCommand(
        new Command("package-manager")
          .argument(
            "<manager>",
            "Package manager to use by default (npm, pnpm, bun, uv, skip, auto)"
          )
          .description("Set the default package manager for dependency installation.")
          .action((manager) => configHandler("set", "package-manager", manager))
      )
      .addCommand(
        new Command("copy-paths")
          .argument(
            "<paths>",
            'Comma-separated file or directory name patterns to search for and copy; supports * and ? globs (e.g., "*.pem,config.local.json,my-dir")'
          )
          .description("Add file/dir name patterns (glob-aware: * and ?) to search for recursively and copy into new worktrees, on top of the built-in defaults. .env* files are always copied.")
          .action((paths) => configHandler("set", "copy-paths", paths))
      )
  )
  .addCommand(
    new Command("get")
      .description("Get a configuration value.")
      .addCommand(
        new Command("editor")
          .description("Get the currently configured default editor.")
          .action(() => configHandler("get", "editor"))
      )
      .addCommand(
        new Command("package-manager")
          .description("Get the currently configured default package manager.")
          .action(() => configHandler("get", "package-manager"))
      )
      .addCommand(
        new Command("copy-paths")
          .description("Get the file/dir name patterns copied into new worktrees (built-in defaults plus any you added; comma-separated).")
          .action(() => configHandler("get", "copy-paths"))
      )
  )
  .addCommand(
    new Command("path")
      .description("Show the path to the configuration file.")
      .action(() => configHandler("path"))
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
