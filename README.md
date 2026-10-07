# gdev

Skills, Claude Code and Codex configs, and a small CLI that installs them. It started as a fork of a git-worktree CLI and grew into the tool I use to keep my AI-agent setup in sync across machines.

It ships one command, `gdev`:

- **`gdev setup`** — a one-command installer for the Claude Code and Codex configs, the skills in `skills/`, the gdev review/QA hooks, the shared `MEMORY.md` instructions, and a small Ghostty config.
- **`gdev new`, `gdev pr`, `gdev list`, …** — git worktree management, built on [John Lindquist's worktree-cli](https://github.com/johnlindquist/worktree-cli).

## Installation

Because `gdev setup` **symlinks** config files out of this repo into your system config directories, the kit is meant to be cloned and linked from source rather than installed from a registry — keep the checkout around, since the symlinks point back into it.

```bash
git clone https://github.com/gal064/ai-skills.git
cd ai-skills
npm install
npm run build
npm link          # exposes `gdev` on your PATH
```

Then install the configs and skills:

```bash
gdev setup
```

Rebuild after pulling changes with `npm run build` (or run `npm run dev` for a watch build).

## Skills

`gdev setup --skills claude,codex` links every `skills/*/SKILL.md` into `~/.claude/skills` (Claude Code) and `~/.agents/skills` (Codex). You can also copy individual skill folders by hand.

| Skill | What it does |
| --- | --- |
| `bro` | Restates the last message in plain language |
| `browser-use` | Drives a real browser through the browser-use CLI |
| `claude-codex-tmux` | Reads or messages Claude Code / Codex sessions running in tmux |
| `context7` | Looks up current library docs via Context7 |
| `deep-research-pdf` | Builds a verified reading list and renders it as a PDF |
| `diff-review` | Reviews diffs and PRs (adapted from opencode, MIT) |
| `exa` | Calls the Exa search API without exposing the key |
| `facts` | Briefs an engineer on the critical facts of an effort |
| `gdev_cycle` | Implement → independent review rounds → QA |
| `gdev_subagents` | Orchestrates work across worktree subagents |
| `ginterview` | Interviews you to produce an implementation spec |
| `gog` | Safe Google Workspace automation with the gog CLI (adapted from openclaw/gogcli, MIT) |

The gdev review/QA hooks are installed alongside the skills for both Claude Code and Codex.

---

## `gdev setup`

```bash
# Guided setup: reuse this machine's saved selection or configure it again.
gdev setup

# Deterministic/non-interactive examples
gdev setup --terminal --yes
gdev setup --ai claude,codex --skills claude,codex --memory claude,codex --yes
gdev setup --terminal --ai claude,codex --yes
gdev setup --ai codex --disable-codex-skills --yes
gdev setup --ai codex --codex-extended-context --yes
gdev setup --ai codex --no-codex-extended-context --yes
gdev setup --ai codex --codex-max-subagents --yes
gdev setup --ai codex --no-codex-max-subagents --yes
gdev setup --ai claude,codex --revoke-relaxed-permissions --yes
```

`gdev setup` has two independent bundles:

- **Terminal (`--terminal`):** a fenced Ghostty block (`copy-on-select = clipboard`; on macOS also Option-as-Alt and slower wheel scrolling) and, on Linux, a fenced Ghostty SSH truecolor block in your shell rc.
- **AI agents (`--ai`):** independently selected Claude Code and Codex settings, skills, the gdev hooks, and shared instructions.

The full skill list is discovered dynamically from `skills/*/SKILL.md`. Setup lists every discovered skill before selection and repeats the exact installed bundle in the confirmation summary. Claude Code skills are symlinked into `~/.claude/skills`; Codex uses `~/.agents/skills`, not `~/.codex/skills`. Installing skills also installs the GDEV review/QA handoff hook. `--memory` links `MEMORY.md` to `~/.claude/CLAUDE.md` and `${CODEX_HOME:-~/.codex}/AGENTS.md`. These are the author's personal working preferences: your existing files are backed up and replaced by a symlink, so later `git pull`s of this repo change your global agent instructions. Read `MEMORY.md` before opting in.

After a successful run, setup saves the machine's complete selection to `${XDG_CONFIG_HOME:-~/.config}/dev/setup-selection.json`. The next plain interactive `gdev setup` asks whether to reuse it; accepting applies that selection without repeating the installer questionnaire, while declining replaces it after the new setup succeeds. The Codex questionnaire also asks whether to disable Codex-provided system, runtime, bundled, and curated-plugin skills, keeping ImageGen, OpenAI Docs, and Sites enabled, and includes every known affected skill in the question. It separately asks whether to set a 400,000-token context window with auto-compaction at 360,000 tokens; this context override defaults to off. It also asks whether to allow up to 10 concurrent Codex subagents, defaulting to yes. Existing version-1 and version-2 saved Codex selections ask any newly introduced questions once when reused, then save the answers. Explicit CLI selections update the same saved file.

Portable AI defaults are merged by owned key instead of replacing settings files. Unknown hooks, project trust, MCP servers, and unrelated settings survive. On macOS, setup disables an already-configured Computer Use MCP; on Linux it preserves valid Computer Use state. On every platform it removes a transport-less Computer Use stub, never synthesizes an incomplete MCP table, and leaves Node REPL untouched. Setup removes the obsolete `service_tier = "default"` while preserving valid service-tier and agent-role settings. Codex disables every configured plugin except the local Sites plugin, and dynamically disables every discovered Codex-provided system or plugin skill except `imagegen`, `openai-docs`, `sites-building`, and `sites-hosting` without copying cache paths between machines. Custom skills outside Codex's system and plugin roots remain untouched. `--codex-extended-context` installs the 400,000/360,000 pair; `--no-codex-extended-context` removes it only while both values still match that pair, preserving custom context values. `--codex-max-subagents` writes the canonical `agents.max_concurrent_threads_per_session = 10` setting and removes the legacy `agents.max_threads` alias; `--no-codex-max-subagents` leaves any existing concurrency setting untouched. `--relaxed-permissions` installs one canonical command policy for Claude and Codex. Common Git and Docker development commands are approved through explicit subcommand allowlists. Publishing commands (git push, docker push/login, docker compose push, gh pr create) and destructive subcommands such as reset, clean, branch deletion, checkout/restore, Docker volume removal, Compose down, and prune are left off the list. The policy also approves interpreters and general tools (`python`, `node`, `find`, `sed`, …) and `kill`/`pkill`, so treat it as trusting the agent, not as a sandbox. `--unsafe-mode` and `--remote-control` remain explicit opt-ins.

Every managed block, hook, TOML key, permission, and symlink is idempotent. Existing destinations are backed up to the next free `.bak`, `.bak.1`, and so on only when their content actually changes. A non-interactive shell must provide `--terminal` and/or `--ai`; setup never silently chooses a bundle.

| Selection | Exact managed destinations |
| --- | --- |
| Terminal | `${XDG_CONFIG_HOME:-~/.config}/ghostty/config` and the fenced Linux SSH truecolor block in `~/.bashrc` or `~/.zshrc` |
| Claude Code | `~/.claude/settings.json`, `~/.claude/statusline.sh`, optional `~/.claude/skills/*` plus the skill manifest, optional `~/.claude/CLAUDE.md`, and `.dev-setup-managed-permissions.json` when managing approvals |
| Codex | `${CODEX_HOME:-~/.codex}/{config.toml,hooks.json}`, optional `${CODEX_HOME:-~/.codex}/rules/*`, `${CODEX_HOME:-~/.codex}/dev-disabled-skills/*`, optional `~/.agents/skills/*` plus the skill manifest, and optional `${CODEX_HOME:-~/.codex}/AGENTS.md` |

**Cross-platform (macOS / Linux).** The worktree commands' "copy the cd command" step auto-detects a clipboard backend: `pbcopy` on macOS, `wl-copy` on Wayland, `xclip`/`xsel` on X11.

---

## Git worktrees

Every worktree command runs directly as `gdev <command>`. These commands come from [worktree-cli](https://github.com/johnlindquist/worktree-cli) by [John Lindquist](https://github.com/johnlindquist), which this project forked and extended. Thanks, John.

### Create a new worktree from a branch name

```bash
gdev new <branchName> [options]
```

If `<branchName>` doesn't exist yet, it is created from the **current branch**, or from the branch you pass with `-b`. The base is printed before the worktree is created, so a wrong base is easy to spot. With no `-b` and a detached HEAD, the command fails. If `<branchName>` already exists, the worktree checks it out as-is (and `-b` is rejected).

Options:
- `-b, --base <branch>`: Branch to create the new branch from (local, then any remote; defaults to the current branch)
- `-p, --path <path>`: Specify a custom path for the worktree
- `-c, --checkout`: Create new branch if it doesn't exist and checkout automatically
- `-i, --install [packageManager]`: Package manager to use for installing dependencies (npm, pnpm, bun, uv, skip, auto, etc.). If no value provided, auto-detects. Use `skip` to disable installation.
- `-e, --editor <editor>`: Editor to use for opening the worktree (overrides default editor)

Example:
```bash
gdev new feature/login
gdev new feature/hotfix -b main
gdev new feature/chat --checkout
gdev new feature/auth -p ./auth-worktree
gdev new feature/deps -i uv
gdev new feature/vscode -e code
gdev new feature/nodeps -i skip  # Skip dependency installation
gdev new feature/autodetect -i   # Force auto-detect (override config)
```

When a worktree is created, the CLI copies the git-ignored local files a fresh checkout needs to be usable — these don't come along with the worktree the way tracked files do. Every `.env*` file found anywhere in the repository is always copied, plus a set of built-in default patterns (`.npmrc`, `app.db`, `settings.local.json`, `*.pem`, `*.key`, the agent-config dirs, …; see `src/config.ts`). You can add your own via `gdev config set copy-paths` — these are searched for throughout the entire repository tree (at any depth) and added on top of the defaults.

**Note:** copy-paths match by **basename** and support `*`/`?` **glob** patterns (e.g. `*.pem` copies every PEM key at any depth; `config.local.json` matches that exact name). A pattern that matches a **directory** copies it whole. Directories that already exist in the new worktree (e.g. git-tracked `.claude/`) are skipped.

By default, it auto-detects lockfiles (`uv.lock`, `package-lock.json`, `yarn.lock`) to install dependencies. You can configure the default behavior with `gdev config set package-manager <manager>`, or use `--install` to override on a per-command basis. Use `--install skip` to disable installation entirely.

### Create a new worktree from a Pull Request number

```bash
gdev pr <prNumber> [options]
```
Uses the GitHub CLI (`gh`) to check out the branch associated with the given Pull Request number, sets it up locally to track the correct remote branch (handling forks automatically), and then creates a worktree for it.

**Benefit:** Commits made in this worktree can be pushed directly using `git push` to update the Pull Request.

**Requires GitHub CLI (`gh`) to be installed and authenticated.**

Options:
- `-p, --path <path>`: Specify a custom path for the worktree (defaults to `<repoName>-<branchName>`)
- `-i, --install [packageManager]`: Package manager to use for installing dependencies (npm, pnpm, bun, uv, skip, auto, etc.). If no value provided, auto-detects.
- `-e, --editor <editor>`: Editor to use for opening the worktree (overrides default editor)

Example:
```bash
# Create worktree for PR #123
gdev pr 123

# Create worktree for PR #456, install deps with npm, open in vscode
gdev pr 456 -i npm -e code
```

### Copy the current worktree state

```bash
gdev copy [branchName] [options]
```

Creates a new worktree seeded from the current HEAD, then mirrors your working tree (staged, unstaged, and untracked changes) into the new location. Useful for cloning an in-progress branch to try out experiments in parallel.

Options:
- `-p, --path <path>`: Specify a custom path for the copied worktree
- `-i, --install [packageManager]`: Package manager to use when installing dependencies (npm, pnpm, bun, uv, skip, auto, etc.). If no value provided, auto-detects.
- `-e, --editor <editor>`: Editor to use for opening the worktree (overrides default editor)

Examples:
```bash
# Create a copy with an auto-generated branch name
gdev copy

# Create a copy on a named branch and open in VS Code
gdev copy feature/experiment -e code
```

### Extract an existing branch as a worktree

```bash
gdev extract [branchName] [options]
```

Extracts an existing branch into a new worktree. If no branch is specified, extracts the current branch. Accepts the same `-p`, `-i`, and `-e` options as `gdev new`.

### Configure default editor

By default no editor is opened (`editor` is set to `none`) — a worktree is created, its files are ready, and you `cd` in yourself. Set a default editor if you'd rather have one launched automatically:

```bash
# Set default editor
gdev config set editor <editorName>

# Examples:
gdev config set editor none     # Don't open anything (the default)
gdev config set editor code     # Use VS Code
gdev config set editor webstorm # Use WebStorm
gdev config set editor cursor   # Use Cursor

# Get current default editor
gdev config get editor

# Show config file location
gdev config path
```

Pass `-e <editor>` to any worktree command to open one for that run without changing the default. `none`, `skip`, and `false` all mean "don't open." (`gdev open` always needs an editor, so it errors if neither `-e` nor a default is set.)

### Configure copy paths

`copy-paths` adds your own patterns on top of the built-in defaults (which already include `.npmrc`, `app.db`, `settings.local.json`, `*.pem`, `*.key`, `service-account.json`, and the agent-config dirs). `.env*` files are always copied regardless.

```bash
# Add extra patterns to search for throughout the repo (glob-aware)
gdev config set copy-paths "config.local.json,*.p12"

# Get the effective copy list (defaults + your additions)
gdev config get copy-paths
```

**How it works:**
- `.env*` files are **always** copied automatically (cannot be disabled)
- The built-in defaults are always applied; `gdev config set copy-paths` **adds** to them (it doesn't replace them), so load-bearing files like `.npmrc` can't be dropped by accident
- Patterns match by **basename** at any depth and support `*`/`?` **globs** (e.g. `*.pem`, `config.local.json`)
- A pattern that matches a **directory** copies it whole; a directory already present in the new worktree is skipped
- Copied secrets (`*.pem`, `service-account.json`, …) are duplicated into each worktree — fine for same-machine local dev

### Configure default package manager

You can set a default package manager to be used when creating worktrees:

```bash
# Set default package manager
gdev config set package-manager <manager>

# Examples:
gdev config set package-manager npm    # Always use npm
gdev config set package-manager pnpm   # Always use pnpm
gdev config set package-manager skip   # Never install dependencies by default
gdev config set package-manager auto   # Auto-detect based on lock files (default)

# Get current default package manager
gdev config get package-manager
```

The default package manager setting will be used for all worktree creation commands (`new`, `copy`, `pr`, `extract`) unless overridden with the `-i` flag.

**Available values:**
- `auto` (default): Auto-detects package manager based on lock files
- `npm`, `pnpm`, `yarn`, `bun`, `uv`: Use specific package manager
- `skip`: Don't install dependencies by default

### List worktrees

```bash
gdev list
```

### Open a worktree

```bash
gdev open [pathOrBranch] [-e <editor>]
```

### Remove a worktree

```bash
gdev remove <pathOrBranch>
```

You can remove a worktree by either its path or branch name:
```bash
gdev remove ./feature/login-worktree
gdev remove feature/chat
```

### Merge and purge

```bash
gdev merge <branchName>   # commit + merge the branch into the current one, then clean up
gdev purge                # remove all worktrees except the main branch (with confirmation)
```

---

## Requirements

- Git
- Node.js
- An editor installed and available in PATH (only if you set a default editor or pass `-e`; no editor is opened by default)
- **GitHub CLI (`gh`) installed and authenticated (for `gdev pr`)**

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Watch build
npm run dev

# Run tests
npm test
```

## Lineage

This kit began as a fork of John Lindquist's [`@johnlindquist/worktree`](https://github.com/johnlindquist/worktree-cli) (MIT); `CHANGELOG.md` preserves that pre-fork history, and `LICENSE` keeps the original copyright. It has since diverged into a personal toolkit and is not published to npm.

## License

MIT — see `LICENSE`.
