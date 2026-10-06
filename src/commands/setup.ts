import { checkbox, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CONFIGS_DIR = path.join(ROOT_DIR, "configs");
const SKILLS_DIR = path.join(ROOT_DIR, "skills");
const GDEV_RUNTIME = path.join(CONFIGS_DIR, "hooks", "gdev-runtime.js");
// Optional inputs: a checkout without these files skips memory and aliases.
const MEMORY_SOURCE = path.join(ROOT_DIR, "MEMORY.md");
const ALIASES_SOURCE = path.join(CONFIGS_DIR, "shell", "ai-aliases.sh");
const RULES_SOURCE = path.join(CONFIGS_DIR, "codex", "rules", "dev.rules");
const DISABLED_SKILL_BLOCK_BEGIN = "# BEGIN dev setup disabled skills";
const DISABLED_SKILL_BLOCK_END = "# END dev setup disabled skills";
const CLAUDE_MANAGED_PERMISSIONS_FILE = ".dev-setup-managed-permissions.json";
const CODEX_MANAGED_HOOKS_FILE = ".dev-setup-managed-hooks.json";
const MANAGED_SKILLS_FILE = ".dev-setup-managed-skills.json";
const SAVED_SETUP_SELECTION_FILE = "setup-selection.json";
const SAVED_SETUP_SELECTION_VERSION = 5;
const LEGACY_SAVED_SETUP_SELECTION_VERSIONS = new Set([1, 2, 3, 4]);
const CODEX_EXTENDED_CONTEXT_WINDOW = 400_000;
const CODEX_EXTENDED_AUTO_COMPACT_LIMIT = 360_000;
const CODEX_EXTENDED_CONTEXT_QUESTION = "Configure Codex with a 400,000-token context window and auto-compact at 360,000 tokens?";
const CODEX_MAX_CONCURRENT_SUBAGENTS = 10;
const CODEX_MAX_SUBAGENTS_QUESTION = `Configure Codex to allow up to ${CODEX_MAX_CONCURRENT_SUBAGENTS} concurrent subagents?`;
// Marker shared by the retired tmux-only notification hooks, used to remove copies setup installed.
const LEGACY_NOTIFY_MARKER = "Only send custom notifications inside tmux (worktree-cli sessions)";
const LEGACY_GDEV_AGENT_NAMES = ["gdev-cycle-worker", "gdev-code-review", "gdev-invariant-review", "gdev-design-review", "gdev-qa"] as const;

export type AgentName = "claude" | "codex";
type InstructionAgent = AgentName;

export interface SetupOptions {
  terminal?: boolean;
  ai?: string;
  yes?: boolean;
  skills?: string;
  memory?: string;
  aliases?: boolean;
  relaxedPermissions?: boolean;
  revokeRelaxedPermissions?: boolean;
  unsafeMode?: boolean;
  remoteControl?: string;
  disableCodexSkills?: boolean;
  codexExtendedContext?: boolean;
  codexMaxSubagents?: boolean;
}

interface SetupPrompts {
  checkbox: typeof checkbox;
  confirm: typeof confirm;
}

export interface SetupRuntime {
  home?: string;
  configHome?: string;
  codexHome?: string;
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  shell?: string;
  prompts?: SetupPrompts;
}

interface ResolvedSetup {
  terminal: boolean;
  agents: Set<AgentName>;
  skills: Set<InstructionAgent>;
  memory: Set<InstructionAgent>;
  aliases: boolean;
  relaxedPermissions: boolean;
  revokeRelaxedPermissions: boolean;
  unsafeMode: boolean;
  remoteControl: Set<InstructionAgent>;
  disableCodexSkills: boolean;
  codexExtendedContext: boolean;
  codexMaxSubagents: boolean;
  needsCodexExtendedContextPrompt: boolean;
  needsCodexMaxSubagentsPrompt: boolean;
  skillNames: string[];
  reusedSavedSelection: boolean;
}

interface RuntimePaths {
  home: string;
  configHome: string;
  codexHome: string;
  platform: NodeJS.Platform;
  isTTY: boolean;
  shell: string;
  prompts: SetupPrompts;
}

interface PreparedClaude {
  settings: string;
  managedPermissions?: string;
}

interface PreparedCodex {
  config: string;
  hooks: string;
  disabledSkillNames: string[];
  disabledSkillLinks: Array<{ source: string; destination: string }>;
}

interface PreparedSetup {
  claude?: PreparedClaude;
  codex?: PreparedCodex;
  skillNames: string[];
  previousSkillTargets: Map<AgentName, Map<string, string>>;
}

const CLAUDE_ONLY_PERMISSIONS = [
  "mcp__ide",
  "Read(*)",
  "Glob(*)",
  "Grep(*)",
  "LS(*)",
  "Agent",
  "TodoRead",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
  "mcp__plugin_context7_context7__resolve-library-id",
  "mcp__plugin_context7_context7__query-docs",
] as const;

const LEGACY_BROAD_CLAUDE_PERMISSIONS = ["Bash(git:*)", "Bash(docker:*)", "Bash(docker-compose:*)"];

const EXACT_CLAUDE_COMMANDS = new Set(["pwd", "whoami"]);

const PLUGIN_STATES: Record<string, boolean> = {
  "github@openai-curated-remote": false,
  "gmail@openai-curated-remote": false,
  "google-calendar@openai-curated-remote": false,
  "google-drive@openai-curated-remote": false,
  "slack@openai-curated-remote": false,
  "hubspot@openai-curated-remote": false,
  "sites@openai-bundled": true,
  "visualize@openai-bundled": false,
  "apollo@openai-curated": false,
  "browser@openai-bundled": false,
  "chrome@openai-bundled": false,
  "computer-use@openai-bundled": false,
  "documents@openai-primary-runtime": false,
  "pdf@openai-primary-runtime": false,
  "spreadsheets@openai-primary-runtime": false,
  "presentations@openai-primary-runtime": false,
  "template-creator@openai-primary-runtime": false,
  "codex-app-tools@openai-bundled": false,
};

const ENABLED_CODEX_SKILL_NAMES = new Set(["imagegen", "openai-docs", "sites-building", "sites-hosting"]);

export const DISABLED_CODEX_SKILL_NAMES = [
  "plugin-management",
  "plugin-creator",
  "review-agent",
  "skill-creator",
  "skill-installer",
  "gmail",
  "gmail-inbox-triage",
  "artifact-template-business-review",
  "artifact-template-analytics-dashboard",
  "artifact-template-design-report",
  "artifact-template-experiment-analysis",
  "artifact-template-financial-budget",
  "artifact-template-investment-committee-memo",
  "artifact-template-legal-memorandum",
  "artifact-template-market-trends-report",
  "artifact-template-minimal-letterhead",
  "artifact-template-operating-calendar",
  "artifact-template-operating-review",
  "artifact-template-project-kickoff",
  "artifact-template-project-tracker",
  "artifact-template-sales-pipeline",
  "artifact-template-simple-dark-mode",
  "artifact-template-simple-light-mode",
  "artifact-template-strategy-memorandum",
  "artifact-template-system-design",
  "artifact-template-team-alignment",
  "artifact-template-three-statement-forecast",
  "google-calendar",
  "google-calendar-daily-brief",
  "google-calendar-free-up-time",
  "google-calendar-group-scheduler",
  "google-calendar-meeting-prep",
  "google-docs",
  "google-drive",
  "google-drive-comments",
  "google-sheets",
  "google-slides",
  "slack",
  "slack-channel-summarization",
  "slack-daily-digest",
  "slack-notification-triage",
  "slack-outgoing-message",
  "slack-reply-drafting",
  "hubspot",
  "hubspot-crm-data-hygiene",
  "hubspot-customer-prep",
  "hubspot-pipeline-health",
  "control-in-app-browser",
  "control-chrome",
  "computer-use",
  "visualize",
  "documents",
  "pdf",
  "presentations",
  "spreadsheets",
  "excel-live-control",
  "template-creator",
] as const;

interface SavedSetupSelection {
  version: typeof SAVED_SETUP_SELECTION_VERSION;
  terminal: boolean;
  agents: AgentName[];
  skills: InstructionAgent[];
  memory: InstructionAgent[];
  aliases: boolean;
  relaxedPermissions: boolean;
  unsafeMode: boolean;
  remoteControl: InstructionAgent[];
  disableCodexSkills: boolean;
  codexExtendedContext: boolean;
  codexMaxSubagents: boolean;
}


function runtimePaths(runtime: SetupRuntime): RuntimePaths {
  const home = runtime.home ?? os.homedir();
  return {
    home,
    configHome: runtime.configHome ?? process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    codexHome: runtime.codexHome ?? process.env.CODEX_HOME ?? path.join(home, ".codex"),
    platform: runtime.platform ?? os.platform(),
    isTTY: runtime.isTTY ?? Boolean(process.stdin.isTTY),
    shell: runtime.shell ?? process.env.SHELL ?? "/bin/bash",
    prompts: runtime.prompts ?? { checkbox, confirm },
  };
}

function savedSetupSelectionPath(paths: RuntimePaths): string {
  return path.join(paths.configHome, "dev", SAVED_SETUP_SELECTION_FILE);
}

function requireBoolean(value: unknown, field: string, filePath: string): boolean {
  if (typeof value !== "boolean") throw new Error(`Cannot parse ${filePath}: ${field} must be a boolean.`);
  return value;
}

function requireAgentArray<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  filePath: string
): Set<T> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Cannot parse ${filePath}: ${field} must be an array of agent names.`);
  }
  const allowedSet = new Set<string>(allowed);
  const invalid = value.filter((entry) => !allowedSet.has(entry));
  if (invalid.length > 0) throw new Error(`Cannot parse ${filePath}: ${field} contains unknown agent(s): ${invalid.join(", ")}.`);
  return new Set(value as T[]);
}

async function loadSavedSetupSelection(paths: RuntimePaths): Promise<ResolvedSetup | null> {
  const filePath = savedSetupSelectionPath(paths);
  if (!(await existsEntry(filePath))) return null;
  const saved = await readJsonObject(filePath);
  if (saved.version !== SAVED_SETUP_SELECTION_VERSION && !LEGACY_SAVED_SETUP_SELECTION_VERSIONS.has(saved.version as number)) {
    throw new Error(`Cannot parse ${filePath}: unsupported version ${String(saved.version)}.`);
  }
  // Older selections may list OpenCode, which setup no longer configures.
  const agents = requireAgentArray<AgentName | "opencode">(saved.agents, "agents", ["claude", "codex", "opencode"], filePath);
  agents.delete("opencode");
  const skills = requireAgentArray(saved.skills, "skills", ["claude", "codex"], filePath);
  const memory = requireAgentArray(saved.memory, "memory", ["claude", "codex"], filePath);
  const remoteControl = requireAgentArray(saved.remoteControl, "remoteControl", ["claude", "codex"], filePath);
  for (const [label, selected] of [["skills", skills], ["memory", memory], ["remoteControl", remoteControl]] as const) {
    const invalid = [...selected].filter((agent) => !agents.has(agent));
    if (invalid.length > 0) throw new Error(`Cannot parse ${filePath}: ${label} contains unselected agent(s): ${invalid.join(", ")}.`);
  }
  const disableCodexSkills = requireBoolean(saved.disableCodexSkills, "disableCodexSkills", filePath);
  if (disableCodexSkills && !agents.has("codex")) {
    throw new Error(`Cannot parse ${filePath}: disableCodexSkills requires Codex in agents.`);
  }
  const codexExtendedContext = saved.version >= 2
    ? requireBoolean(saved.codexExtendedContext, "codexExtendedContext", filePath)
    : false;
  if (codexExtendedContext && !agents.has("codex")) {
    throw new Error(`Cannot parse ${filePath}: codexExtendedContext requires Codex in agents.`);
  }
  const codexMaxSubagents = saved.version >= 3
    ? requireBoolean(saved.codexMaxSubagents, "codexMaxSubagents", filePath)
    : false;
  if (codexMaxSubagents && !agents.has("codex")) {
    throw new Error(`Cannot parse ${filePath}: codexMaxSubagents requires Codex in agents.`);
  }
  const terminal = requireBoolean(saved.terminal, "terminal", filePath);
  return {
    terminal,
    agents: agents as Set<AgentName>,
    skills,
    memory,
    aliases: requireBoolean(saved.aliases, "aliases", filePath),
    relaxedPermissions: requireBoolean(saved.relaxedPermissions, "relaxedPermissions", filePath),
    revokeRelaxedPermissions: false,
    unsafeMode: requireBoolean(saved.unsafeMode, "unsafeMode", filePath),
    remoteControl,
    disableCodexSkills,
    codexExtendedContext,
    codexMaxSubagents,
    needsCodexExtendedContextPrompt: saved.version === 1 && agents.has("codex"),
    needsCodexMaxSubagentsPrompt: saved.version < 3 && agents.has("codex"),
    skillNames: skills.size > 0 ? await discoverInstallableSkills() : [],
    reusedSavedSelection: true,
  };
}

function serializeSetupSelection(setup: ResolvedSetup): string {
  const saved: SavedSetupSelection = {
    version: SAVED_SETUP_SELECTION_VERSION,
    terminal: setup.terminal,
    agents: [...setup.agents].sort(),
    skills: [...setup.skills].sort(),
    memory: [...setup.memory].sort(),
    aliases: setup.aliases,
    relaxedPermissions: setup.relaxedPermissions,
    unsafeMode: setup.unsafeMode,
    remoteControl: [...setup.remoteControl].sort(),
    disableCodexSkills: setup.disableCodexSkills,
    codexExtendedContext: setup.codexExtendedContext,
    codexMaxSubagents: setup.codexMaxSubagents,
  };
  return `${JSON.stringify(saved, null, 2)}\n`;
}

function parseAgents(value: string | undefined, allowed: readonly AgentName[]): Set<AgentName> {
  if (!value) return new Set();
  const requested = value.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const allowedSet = new Set<string>(allowed);
  const invalid = requested.filter((entry) => !allowedSet.has(entry));
  if (invalid.length > 0) throw new Error(`Unknown agent(s): ${invalid.join(", ")}`);
  return new Set(requested as AgentName[]);
}

function instructionAgents(value: string | undefined): Set<InstructionAgent> {
  return parseAgents(value, ["claude", "codex"]) as Set<InstructionAgent>;
}

async function resolveSetup(options: SetupOptions, paths: RuntimePaths): Promise<ResolvedSetup> {
  const hasExplicitBundle = options.terminal === true || options.ai !== undefined;
  if (!paths.isTTY && !hasExplicitBundle) {
    throw new Error("Non-interactive setup requires --terminal and/or --ai <claude,codex>.");
  }

  if (paths.isTTY && !hasExplicitBundle) {
    const saved = await loadSavedSetupSelection(paths);
    if (saved && await paths.prompts.confirm({
      message: `Use this machine's saved setup selection from ${savedSetupSelectionPath(paths)}?`,
      default: true,
    })) {
      if (saved.needsCodexExtendedContextPrompt) {
        saved.codexExtendedContext = await paths.prompts.confirm({
          message: CODEX_EXTENDED_CONTEXT_QUESTION,
          default: false,
        });
        saved.needsCodexExtendedContextPrompt = false;
      }
      if (saved.needsCodexMaxSubagentsPrompt) {
        saved.codexMaxSubagents = await paths.prompts.confirm({
          message: CODEX_MAX_SUBAGENTS_QUESTION,
          default: true,
        });
        saved.needsCodexMaxSubagentsPrompt = false;
      }
      return saved;
    }
  }

  let terminal = options.terminal === true;
  let agents = parseAgents(options.ai, ["claude", "codex"]);
  if (options.ai !== undefined && agents.size === 0) {
    throw new Error("--ai requires at least one of: claude,codex.");
  }
  if (options.relaxedPermissions && options.revokeRelaxedPermissions) {
    throw new Error("Choose either --relaxed-permissions or --revoke-relaxed-permissions, not both.");
  }

  if (!hasExplicitBundle) {
    const bundles = await paths.prompts.checkbox<"terminal" | "ai">({
      message: "Choose setup bundles:",
      choices: [
        { name: "Terminal — Ghostty config, SSH truecolor", value: "terminal" },
        { name: "AI agents — Claude Code, Codex, skills, instructions, aliases", value: "ai" },
      ],
    });
    terminal = bundles.includes("terminal");
    if (bundles.includes("ai")) {
      agents = new Set(await paths.prompts.checkbox<AgentName>({
        message: "Choose AI agents:",
        choices: [
          { name: "Claude Code", value: "claude" },
          { name: "Codex", value: "codex" },
        ],
      }));
    }
  }

  const selectedInstructionAgents = [...agents];
  let skills = instructionAgents(options.skills);
  let memory = instructionAgents(options.memory);
  let aliases = options.aliases === true;
  let relaxedPermissions = options.relaxedPermissions === true;
  let unsafeMode = options.unsafeMode === true;
  let remoteControl = instructionAgents(options.remoteControl);
  let disableCodexSkills = agents.has("codex") && options.disableCodexSkills !== false;
  let codexExtendedContext = options.codexExtendedContext === true;
  let codexMaxSubagents = options.codexMaxSubagents === true;
  let skillNames: string[] = [];
  const hasMemorySource = await existsEntry(MEMORY_SOURCE);
  const hasAliasesSource = await existsEntry(ALIASES_SOURCE);
  if (memory.size > 0 && !hasMemorySource) throw new Error(`--memory needs ${MEMORY_SOURCE}, which is not in this checkout.`);
  if (aliases && !hasAliasesSource) throw new Error(`--aliases needs ${ALIASES_SOURCE}, which is not in this checkout.`);

  for (const [label, selected] of [["skills", skills], ["memory", memory], ["remote control", remoteControl]] as const) {
    const invalid = [...selected].filter((agent) => !agents.has(agent));
    if (invalid.length > 0) throw new Error(`${label} requested for unselected agent(s): ${invalid.join(", ")}`);
  }
  if (unsafeMode && !agents.has("claude")) throw new Error("--unsafe-mode requires Claude in --ai.");
  if (relaxedPermissions && selectedInstructionAgents.length === 0) {
    throw new Error("--relaxed-permissions requires Claude and/or Codex in --ai.");
  }
  if (options.revokeRelaxedPermissions && selectedInstructionAgents.length === 0) {
    throw new Error("--revoke-relaxed-permissions requires Claude and/or Codex in --ai.");
  }
  if (aliases && agents.size === 0) throw new Error("--aliases requires --ai.");
  if (options.disableCodexSkills && !agents.has("codex")) throw new Error("--disable-codex-skills requires Codex in --ai.");
  if (options.codexExtendedContext !== undefined && !agents.has("codex")) {
    throw new Error("--codex-extended-context and --no-codex-extended-context require Codex in --ai.");
  }
  if (options.codexMaxSubagents !== undefined && !agents.has("codex")) {
    throw new Error("--codex-max-subagents and --no-codex-max-subagents require Codex in --ai.");
  }

  if (paths.isTTY && agents.size > 0 && !options.yes) {
    if (selectedInstructionAgents.length > 0 && options.skills === undefined) {
      skillNames = await discoverInstallableSkills();
      console.log(chalk.bold("\nFull repository skill bundle discovered:"));
      for (const skillName of skillNames) console.log(`  - ${skillName}`);
      const picked = await paths.prompts.checkbox<InstructionAgent>({
        message: `Install this full ${skillNames.length}-skill bundle for:`,
        choices: selectedInstructionAgents.map((agent) => ({ name: agent === "claude" ? "Claude Code" : "Codex", value: agent })),
      });
      skills = new Set(picked);
    }
    if (hasMemorySource && selectedInstructionAgents.length > 0 && options.memory === undefined) {
      const picked = await paths.prompts.checkbox<InstructionAgent>({
        message: "Symlink shared global instructions for:",
        choices: selectedInstructionAgents.map((agent) => ({ name: agent === "claude" ? "Claude Code" : "Codex", value: agent })),
      });
      memory = new Set(picked);
    }
    if (hasAliasesSource && options.aliases === undefined) aliases = await paths.prompts.confirm({ message: `Install the shell aliases from ${ALIASES_SOURCE}?`, default: true });
    if (options.relaxedPermissions === undefined && selectedInstructionAgents.length > 0) {
      relaxedPermissions = await paths.prompts.confirm({
        message: "Auto-approve the managed command policy? It includes interpreters such as python and node, so it trusts the agent; publishing commands (git push, docker push/login, docker compose push, gh pr create) and destructive Git/Docker subcommands are not on the list.",
        default: false,
      });
    }
    if (agents.has("codex") && options.disableCodexSkills === undefined) {
      const discoveredDisabledSkills = [...(await resolveDisabledSkills(paths)).keys()].sort();
      const disabledSkillsToShow = discoveredDisabledSkills.length > 0
        ? discoveredDisabledSkills
        : DISABLED_CODEX_SKILL_NAMES;
      disableCodexSkills = await paths.prompts.confirm({
        message: `Disable these Codex skills?\n${disabledSkillsToShow.map((name) => `  - ${name}`).join("\n")}`,
        default: true,
      });
    }
    if (agents.has("codex") && options.codexExtendedContext === undefined) {
      codexExtendedContext = await paths.prompts.confirm({
        message: CODEX_EXTENDED_CONTEXT_QUESTION,
        default: false,
      });
    }
    if (agents.has("codex") && options.codexMaxSubagents === undefined) {
      codexMaxSubagents = await paths.prompts.confirm({
        message: CODEX_MAX_SUBAGENTS_QUESTION,
        default: true,
      });
    }
    if (options.unsafeMode === undefined && agents.has("claude")) {
      unsafeMode = await paths.prompts.confirm({ message: "Hide Claude's dangerous-mode warning prompt?", default: false });
    }
    if (options.remoteControl === undefined && selectedInstructionAgents.length > 0) {
      const picked = await paths.prompts.checkbox<InstructionAgent>({
        message: "Enable remote-control/mobile behavior for:",
        choices: selectedInstructionAgents.map((agent) => ({ name: agent === "claude" ? "Claude push notifications" : "Codex remote control", value: agent })),
      });
      remoteControl = new Set(picked);
    }
  }

  if (skills.size > 0 && skillNames.length === 0) skillNames = await discoverInstallableSkills();

  return {
    terminal,
    agents,
    skills,
    memory,
    aliases,
    relaxedPermissions,
    revokeRelaxedPermissions: options.revokeRelaxedPermissions === true,
    unsafeMode,
    remoteControl,
    disableCodexSkills,
    codexExtendedContext,
    codexMaxSubagents,
    needsCodexExtendedContextPrompt: false,
    needsCodexMaxSubagentsPrompt: false,
    skillNames,
    reusedSavedSelection: false,
  };
}

async function existsEntry(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function backup(target: string): Promise<string | null> {
  let stat;
  try { stat = await fs.lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let backupPath = `${target}.bak`;
  for (let suffix = 1; await existsEntry(backupPath); suffix++) backupPath = `${target}.bak.${suffix}`;
  if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(target), backupPath);
  else if (stat.isDirectory()) await fs.cp(target, backupPath, { recursive: true });
  else await fs.copyFile(target, backupPath);
  console.log(chalk.dim(`  Backed up ${target} -> ${backupPath}`));
  return backupPath;
}

async function removeEntry(target: string): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await fs.rm(target, { recursive: true, force: true });
    else await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function installSymlinkIdempotent(source: string, destination: string): Promise<void> {
  try {
    const current = await fs.readlink(destination);
    if (path.resolve(path.dirname(destination), current) === path.resolve(source)) return;
  } catch { /* replace non-symlinks and missing paths */ }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await backup(destination);
  await removeEntry(destination);
  await fs.symlink(source, destination);
}

export const installSymlink = installSymlinkIdempotent;

export async function installSkillSymlinks(
  sourceRoot: string,
  destinationRoot: string,
  skillNames: string[]
): Promise<void> {
  for (const skillName of skillNames) {
    await installSymlinkIdempotent(
      path.join(sourceRoot, skillName),
      path.join(destinationRoot, skillName)
    );
  }
}

export function getMemoryTargets(
  home: string,
  codexHome: string
): Record<InstructionAgent, string> {
  return {
    claude: path.join(home, ".claude", "CLAUDE.md"),
    codex: path.join(codexHome, "AGENTS.md"),
  };
}

async function writeChanged(destination: string, content: string, executable = false): Promise<void> {
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isSymbolicLink() && await fs.readFile(destination, "utf8") === content) {
      if (executable) await fs.chmod(destination, 0o755);
      return;
    }
  } catch { /* create */ }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await backup(destination);
  await removeEntry(destination);
  await fs.writeFile(destination, content, executable ? { mode: 0o755 } : undefined);
}

async function copyChanged(source: string, destination: string, executable = false): Promise<void> {
  await writeChanged(destination, await fs.readFile(source, "utf8"), executable);
}

export async function upsertFencedBlock(
  destination: string,
  label: string,
  body: string,
  legacyMarker?: string
): Promise<void> {
  const start = `# === START ${label} ===`;
  const end = `# === END ${label} ===`;
  const block = `${start}\n${body.trim()}\n${end}`;
  let existing = "";
  try { existing = await fs.readFile(destination, "utf8"); } catch { /* create */ }
  if (legacyMarker) {
    const legacyBlock = `${legacyMarker}\n${body.trim()}`;
    existing = existing.replace(legacyBlock, "");
  }
  const expression = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`, "g");
  const matches = existing.match(expression) ?? [];
  let next: string;
  if (matches.length > 0) {
    next = existing.replace(expression, (match, offset) => offset === existing.indexOf(matches[0]!) ? block : "");
  } else {
    next = existing.trimEnd() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
  }
  if (next !== existing) await writeChanged(destination, next);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function discoverInstallableSkills(skillsDirectory = SKILLS_DIR): Promise<string[]> {
  const entries = await fs.readdir(skillsDirectory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { await fs.access(path.join(skillsDirectory, entry.name, "SKILL.md")); found.push(entry.name); } catch { /* not a skill */ }
  }
  return found.sort();
}

function shellConfig(paths: RuntimePaths): string {
  return path.join(paths.home, path.basename(paths.shell).includes("zsh") ? ".zshrc" : ".bashrc");
}

async function installTerminal(paths: RuntimePaths): Promise<void> {
  const ghosttySource = path.join(CONFIGS_DIR, "ghostty", paths.platform === "darwin" ? "config" : "config-common");
  await upsertFencedBlock(
    path.join(paths.configHome, "ghostty", "config"),
    "DEV SETUP GHOSTTY",
    await fs.readFile(ghosttySource, "utf8"),
    "# Added by dev setup"
  );
  if (paths.platform === "linux") {
    await upsertFencedBlock(
      shellConfig(paths),
      "GHOSTTY SSH TRUECOLOR",
      await fs.readFile(path.join(CONFIGS_DIR, "shell", "ghostty-ssh-truecolor.sh"), "utf8")
    );
  }
}

async function removeLegacyNotifier(filePath: string): Promise<void> {
  try {
    if ((await fs.readFile(filePath, "utf8")).includes(LEGACY_NOTIFY_MARKER)) await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

// Setup used to install a tmux/Fresh/lazygit workflow and an OpenCode notifier.
// Remove only what still points back into this repository's retired configs.
async function retireLegacyTerminalConfig(paths: RuntimePaths): Promise<void> {
  const retiredSources = ["tmux.conf", "tmux", "fresh", "lazygit"].map((name) => path.join(CONFIGS_DIR, name));
  const isRetiredLink = async (destination: string) => {
    try {
      const target = path.resolve(path.dirname(destination), await fs.readlink(destination));
      return retiredSources.some((source) => target === source || target.startsWith(`${source}${path.sep}`));
    } catch {
      return false;
    }
  };
  const freshPlugins = path.join(paths.configHome, "fresh", "plugins");
  let pluginLinks: string[] = [];
  try { pluginLinks = (await fs.readdir(freshPlugins)).map((name) => path.join(freshPlugins, name)); } catch { /* not installed */ }
  for (const destination of [
    path.join(paths.home, ".tmux.conf"),
    path.join(paths.configHome, "fresh", "config.json"),
    path.join(paths.configHome, "fresh", "themes"),
    ...pluginLinks,
    path.join(paths.home, "Library", "Application Support", "lazygit", "config.yml"),
    path.join(paths.configHome, "lazygit", "config.yml"),
  ]) {
    if (await isRetiredLink(destination)) await fs.unlink(destination);
  }
  await removeEntry(path.join(paths.home, ".config", "dev", "tmux-title-sync.conf"));
  await removeLegacyNotifier(path.join(paths.configHome, "opencode", "plugins", "notification.js"));
}

async function loadSharedAllowPrefixes(): Promise<string[][]> {
  const rules = await fs.readFile(RULES_SOURCE, "utf8");
  const prefixes: string[][] = [];
  for (const line of rules.split("\n")) {
    const match = line.match(/prefix_rule\(pattern = (\[[^\]]+\]), decision = "allow"/);
    if (match) prefixes.push(JSON.parse(match[1]!) as string[]);
  }
  return prefixes;
}

export function renderClaudeCommandPermissions(prefixes: string[][]): string[] {
  return prefixes.map((tokens) => {
    const command = tokens.join(" ");
    return `Bash(${command}${EXACT_CLAUDE_COMMANDS.has(command) ? "" : ":*"})`;
  });
}

export function mergeManagedPermissions(
  current: unknown,
  previousManaged: unknown,
  nextManaged: string[]
): string[] {
  const existing = Array.isArray(current) ? current.filter((permission): permission is string => typeof permission === "string") : [];
  const previous = new Set(Array.isArray(previousManaged) ? previousManaged.filter((permission): permission is string => typeof permission === "string") : []);
  return [...new Set([...existing.filter((permission) => !previous.has(permission)), ...nextManaged])];
}

function mergeHookEntries<T>(existing: unknown, additions: T[]): T[] {
  const current = Array.isArray(existing) ? existing : [];
  const serialized = new Set(current.map((item) => JSON.stringify(item)));
  return [...current, ...additions.filter((item) => !serialized.has(JSON.stringify(item)))];
}

function replaceManagedHookEntries<T>(
  existing: unknown,
  additions: T[],
  isManaged: (entry: unknown) => boolean
): T[] {
  return mergeHookEntries(
    Array.isArray(existing) ? existing.filter((entry) => !isManaged(entry)) : [],
    additions
  );
}

async function readJsonObject(filePath: string): Promise<Record<string, any>> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    return parsed;
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${(error as Error).message}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObjectProperty(parent: Record<string, any>, key: string, filePath: string): Record<string, any> {
  const value = parent[key];
  if (value === undefined) return (parent[key] = {});
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Cannot merge ${filePath}: ${key} must be a JSON object.`);
  }
  return value;
}

async function prepareClaude(paths: RuntimePaths, setup: ResolvedSetup): Promise<PreparedClaude> {
  const claudeHome = path.join(paths.home, ".claude");
  const statuslinePath = path.join(claudeHome, "statusline.sh");
  const settingsPath = path.join(claudeHome, "settings.json");
  const settings = await readJsonObject(settingsPath);
  const defaults = JSON.parse(await fs.readFile(path.join(CONFIGS_DIR, "claude", "settings.defaults.json"), "utf8"));
  Object.assign(settings, defaults);
  settings.hooks = requireObjectProperty(settings, "hooks", settingsPath);
  const isClaudeNotifyHook = (entry: unknown) => {
    const serialized = JSON.stringify(entry);
    return serialized.includes("/.claude/hooks/notify.sh") && serialized.includes("Claude Code");
  };
  for (const event of ["Stop", "Notification"]) {
    const remaining = replaceManagedHookEntries(settings.hooks[event], [], isClaudeNotifyHook);
    if (remaining.length) settings.hooks[event] = remaining;
    else delete settings.hooks[event];
  }
  if (setup.skills.has("claude")) {
    const runtimeCommand = `node "${GDEV_RUNTIME}" claude`;
    const isGdevHook = (entry: unknown) => JSON.stringify(entry).includes("gdev-runtime.js");
    settings.hooks.PostToolUse = replaceManagedHookEntries(settings.hooks.PostToolUse, [{
      matcher: "Agent",
      hooks: [{ type: "command", command: runtimeCommand, timeout: 5, statusMessage: "Preparing GDEV handoff..." }],
    }], isGdevHook);
    settings.hooks.SubagentStart = replaceManagedHookEntries(settings.hooks.SubagentStart, [], isGdevHook);
    settings.hooks.SubagentStop = replaceManagedHookEntries(settings.hooks.SubagentStop, [], isGdevHook);
  }
  settings.statusLine = { type: "command", command: `/bin/bash "${statuslinePath}"` };
  let managedPermissions: string | undefined;
  if (setup.relaxedPermissions || setup.revokeRelaxedPermissions) {
    settings.permissions = requireObjectProperty(settings, "permissions", settingsPath);
    const permissions = setup.relaxedPermissions
      ? [...CLAUDE_ONLY_PERMISSIONS, ...renderClaudeCommandPermissions(await loadSharedAllowPrefixes())]
      : [];
    const manifestPath = path.join(claudeHome, CLAUDE_MANAGED_PERMISSIONS_FILE);
    const manifestExists = await existsEntry(manifestPath);
    const previousManifest = await readJsonObject(manifestPath);
    const previousAllow = manifestExists
      ? previousManifest.allow ?? previousManifest.permissions
      : LEGACY_BROAD_CLAUDE_PERMISSIONS;
    settings.permissions.allow = mergeManagedPermissions(settings.permissions.allow, previousAllow, permissions);
    // Setup manages an allowlist only; anything unlisted already prompts, so drop the ask list we used to write.
    const remainingAsk = mergeManagedPermissions(settings.permissions.ask, previousManifest.ask, []);
    if (remainingAsk.length) settings.permissions.ask = remainingAsk;
    else delete settings.permissions.ask;
    managedPermissions = `${JSON.stringify({ allow: permissions }, null, 2)}\n`;
  }
  if (setup.unsafeMode) settings.skipDangerousModePermissionPrompt = true;
  if (setup.remoteControl.has("claude")) settings.agentPushNotifEnabled = true;
  return { settings: `${JSON.stringify(settings, null, 2)}\n`, managedPermissions };
}

async function retireLegacyGdevAgents(directory: string, extension: string): Promise<void> {
  for (const name of LEGACY_GDEV_AGENT_NAMES) {
    const target = path.join(directory, `${name}.${extension}`);
    let stat;
    try { stat = await fs.lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // Setup installed Claude definitions as symlinks and Codex definitions as
    // files. Preserve a possibly edited file, but do not leave active named
    // agents behind now that GDEV delegates to ordinary native subagents.
    if (!stat.isSymbolicLink()) await backup(target);
    await removeEntry(target);
  }
}

async function installClaude(paths: RuntimePaths, setup: ResolvedSetup, prepared: PreparedClaude): Promise<void> {
  const claudeHome = path.join(paths.home, ".claude");
  await removeLegacyNotifier(path.join(claudeHome, "hooks", "notify.sh"));
  await copyChanged(path.join(CONFIGS_DIR, "claude", "statusline.sh"), path.join(claudeHome, "statusline.sh"), true);
  await writeChanged(path.join(claudeHome, "settings.json"), prepared.settings);
  if (prepared.managedPermissions !== undefined) {
    await writeChanged(path.join(claudeHome, CLAUDE_MANAGED_PERMISSIONS_FILE), prepared.managedPermissions);
  }
  if (setup.skills.has("claude")) {
    await retireLegacyGdevAgents(path.join(claudeHome, "agents"), "md");
  }
}

function findSection(lines: string[], section: string): [number, number] | null {
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index]!.trimStart().startsWith("[")) { end = index; break; }
  }
  return [start, end];
}

export function setTomlValue(content: string, section: string, key: string, value: string): string {
  const lines = content.trimEnd() ? content.trimEnd().split("\n") : [];
  let range = findSection(lines, section);
  if (!range) {
    if (lines.length && lines.at(-1)?.trim()) lines.push("");
    lines.push(`[${section}]`);
    range = [lines.length - 1, lines.length];
  }
  const [start, initialEnd] = range;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const matches: number[] = [];
  for (let index = start + 1; index < initialEnd; index++) if (keyPattern.test(lines[index]!)) matches.push(index);
  if (matches.length === 0) lines.splice(initialEnd, 0, `${key} = ${value}`);
  else {
    lines[matches[0]!] = `${key} = ${value}`;
    for (const duplicate of matches.slice(1).reverse()) lines.splice(duplicate, 1);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function setTopLevelTomlValue(content: string, key: string, value: string): string {
  const lines = content.trimEnd() ? content.trimEnd().split("\n") : [];
  const sectionStart = lines.findIndex((line) => line.trimStart().startsWith("["));
  const topLevelEnd = sectionStart < 0 ? lines.length : sectionStart;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const matches: number[] = [];
  for (let index = 0; index < topLevelEnd; index++) if (keyPattern.test(lines[index]!)) matches.push(index);
  if (matches.length === 0) {
    let insertAt = topLevelEnd;
    while (insertAt > 0 && !lines[insertAt - 1]!.trim()) insertAt--;
    lines.splice(insertAt, 0, `${key} = ${value}`);
    if (insertAt === 0 && lines[1]?.trimStart().startsWith("[")) lines.splice(1, 0, "");
  } else {
    lines[matches[0]!] = `${key} = ${value}`;
    for (const duplicate of matches.slice(1).reverse()) lines.splice(duplicate, 1);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function removeTopLevelTomlValue(content: string, key: string): string {
  const lines = content.trimEnd() ? content.trimEnd().split("\n") : [];
  const sectionStart = lines.findIndex((line) => line.trimStart().startsWith("["));
  const topLevelEnd = sectionStart < 0 ? lines.length : sectionStart;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const next = lines.filter((line, index) => index >= topLevelEnd || !keyPattern.test(line));
  while (next[0] !== undefined && !next[0].trim()) next.shift();
  return next.length ? `${next.join("\n").trimEnd()}\n` : "";
}

function removeTomlValue(content: string, section: string, key: string): string {
  const lines = content.trimEnd() ? content.trimEnd().split("\n") : [];
  const range = findSection(lines, section);
  if (!range) return content;
  const [start, end] = range;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const body = lines.slice(start + 1, end).filter((line) => !keyPattern.test(line));
  const hasValues = body.some((line) => line.trim() && !line.trimStart().startsWith("#"));
  lines.splice(start, end - start, ...(hasValues ? [lines[start]!, ...body] : []));
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  return lines.length ? `${lines.join("\n").trimEnd()}\n` : "";
}

function removeTomlSection(content: string, section: string): string {
  const lines = content.trimEnd() ? content.trimEnd().split("\n") : [];
  const range = findSection(lines, section);
  if (!range) return content;
  lines.splice(range[0], range[1] - range[0]);
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  return lines.length ? `${lines.join("\n").trimEnd()}\n` : "";
}

export function reconcileCodexExtendedContext(content: string, enabled: boolean): string {
  if (enabled) {
    return setTopLevelTomlValue(
      setTopLevelTomlValue(content, "model_context_window", String(CODEX_EXTENDED_CONTEXT_WINDOW)),
      "model_auto_compact_token_limit",
      String(CODEX_EXTENDED_AUTO_COMPACT_LIMIT)
    );
  }
  const parsed = parseToml(content) as Record<string, unknown>;
  if (
    parsed.model_context_window !== CODEX_EXTENDED_CONTEXT_WINDOW ||
    parsed.model_auto_compact_token_limit !== CODEX_EXTENDED_AUTO_COMPACT_LIMIT
  ) return content;
  return removeTopLevelTomlValue(
    removeTopLevelTomlValue(content, "model_context_window"),
    "model_auto_compact_token_limit"
  );
}

export function reconcileCodexMaxSubagents(content: string, enabled: boolean): string {
  if (!enabled) return content;
  return setTomlValue(
    removeTomlValue(content, "agents", "max_threads"),
    "agents",
    "max_concurrent_threads_per_session",
    String(CODEX_MAX_CONCURRENT_SUBAGENTS)
  );
}

function applyTomlDefaults(content: string, defaults: string): string {
  let section = "";
  let next = content;
  for (const rawLine of defaults.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1);
      continue;
    }
    const separator = line.indexOf("=");
    if (!section || separator < 0) continue;
    next = setTomlValue(
      next,
      section,
      line.slice(0, separator).trim(),
      line.slice(separator + 1).trim()
    );
  }
  return next;
}

async function resolveDisabledSkills(paths: RuntimePaths): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const visited = new Set<string>();
  const roots = [
    path.join(paths.codexHome, "skills", ".system"),
    path.join(paths.codexHome, "plugins"),
  ];
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let real: string;
    try { real = await fs.realpath(directory); } catch { return; }
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try {
      entries = (await fs.readdir(directory, { withFileTypes: true }))
        .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true }));
    } catch { return; }
    const skillName = path.basename(directory);
    if (
      !found.has(skillName) &&
      !ENABLED_CODEX_SKILL_NAMES.has(skillName) &&
      entries.some((entry) => entry.name === "SKILL.md")
    ) {
      found.set(skillName, path.join(directory, "SKILL.md"));
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) await walk(path.join(directory, entry.name), depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
  return found;
}

function replaceManagedDisabledSkills(content: string, skills: Map<string, string>): string {
  const expression = new RegExp(`${escapeRegExp(DISABLED_SKILL_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(DISABLED_SKILL_BLOCK_END)}\\n?`, "g");
  const unmanaged = content.replace(expression, "").trimEnd();
  if (skills.size === 0) return unmanaged ? `${unmanaged}\n` : "";
  const entries = [...skills.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, skillPath]) =>
    `[[skills.config]]\npath = ${JSON.stringify(skillPath)}\nenabled = false`
  ).join("\n\n");
  return `${unmanaged}${unmanaged ? "\n\n" : ""}${DISABLED_SKILL_BLOCK_BEGIN}\n${entries}\n${DISABLED_SKILL_BLOCK_END}\n`;
}

function assertValidToml(content: string, filePath: string): void {
  try {
    parseToml(content);
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${(error as Error).message}`);
  }
}

async function prepareCodex(paths: RuntimePaths, setup: ResolvedSetup): Promise<PreparedCodex> {
  const configPath = path.join(paths.codexHome, "config.toml");
  let config = "";
  try { config = await fs.readFile(configPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertValidToml(config, configPath);
  config = applyTomlDefaults(
    config,
    await fs.readFile(path.join(CONFIGS_DIR, "codex", "config.defaults.toml"), "utf8")
  );
  const legacyConfig = parseToml(config) as Record<string, any>;
  if (legacyConfig.service_tier === "default") config = removeTopLevelTomlValue(config, "service_tier");
  config = reconcileCodexExtendedContext(config, setup.codexExtendedContext);
  config = reconcileCodexMaxSubagents(config, setup.codexMaxSubagents);
  if (setup.remoteControl.has("codex")) config = setTomlValue(config, "features", "remote_control", "true");
  const configuredPlugins = (parseToml(config) as Record<string, any>).plugins;
  const pluginNames = new Set([
    ...Object.keys(isPlainObject(configuredPlugins) ? configuredPlugins : {}),
    ...Object.keys(PLUGIN_STATES),
  ]);
  for (const plugin of pluginNames) {
    const enabled = PLUGIN_STATES[plugin] ?? false;
    config = setTomlValue(config, `plugins.${JSON.stringify(plugin)}`, "enabled", String(enabled));
  }
  const configuredMcpServers = (parseToml(config) as Record<string, any>).mcp_servers;
  const computerUse = isPlainObject(configuredMcpServers) ? configuredMcpServers["computer-use"] : undefined;
  if (isPlainObject(computerUse)) {
    const hasTransport = typeof computerUse.command === "string" || typeof computerUse.url === "string";
    if (!hasTransport) {
      config = removeTomlSection(config, "mcp_servers.computer-use");
      config = removeTomlSection(config, `mcp_servers.${JSON.stringify("computer-use")}`);
    } else if (paths.platform === "darwin") {
      config = setTomlValue(config, "mcp_servers.computer-use", "enabled", "false");
    }
  }
  const resolvedSkills = setup.disableCodexSkills ? await resolveDisabledSkills(paths) : new Map<string, string>();
  const stableSkills = new Map<string, string>();
  const disabledSkillLinks: PreparedCodex["disabledSkillLinks"] = [];
  for (const [name, manifest] of resolvedSkills) {
    const directory = path.dirname(manifest);
    const stableDirectories = [
      path.join(paths.home, ".agents", "skills", name),
      path.join(paths.home, ".claude", "skills", name),
      path.join(paths.codexHome, "skills", name),
      path.join(paths.codexHome, "skills", ".system", name),
    ];
    if (stableDirectories.some((candidate) => path.resolve(candidate) === path.resolve(directory))) {
      stableSkills.set(name, manifest);
    } else {
      const destination = path.join(paths.codexHome, "dev-disabled-skills", name);
      disabledSkillLinks.push({ source: directory, destination });
      stableSkills.set(name, path.join(destination, "SKILL.md"));
    }
  }
  config = replaceManagedDisabledSkills(config, stableSkills);
  assertValidToml(config, configPath);

  const hooksPath = path.join(paths.codexHome, "hooks.json");
  const hooks = await readJsonObject(hooksPath);
  hooks.hooks = requireObjectProperty(hooks, "hooks", hooksPath);
  const managedHooksPath = path.join(paths.codexHome, CODEX_MANAGED_HOOKS_FILE);
  const previousManagedHooks = await readJsonObject(managedHooksPath);
  const previousEntries = new Set(
    (Array.isArray(previousManagedHooks.hooks) ? previousManagedHooks.hooks : []).map((entry: unknown) => JSON.stringify(entry))
  );
  const remainingStop = replaceManagedHookEntries(
    hooks.hooks.Stop,
    [],
    (entry) => {
      const serialized = JSON.stringify(entry);
      return previousEntries.has(serialized) || serialized.includes("/.codex/notify.sh");
    }
  );
  if (remainingStop.length) hooks.hooks.Stop = remainingStop;
  else delete hooks.hooks.Stop;
  if (setup.skills.has("codex")) {
    const runtimeCommand = `node "${GDEV_RUNTIME}" codex`;
    const isGdevHook = (entry: unknown) => JSON.stringify(entry).includes("gdev-runtime.js");
    // Codex encrypts the delegated message before the hook sees it, so the
    // runtime routes on the plaintext task_name. Claude's Agent input exposes
    // the equivalent short description. Both hosts therefore use PostToolUse.
    hooks.hooks.SubagentStop = replaceManagedHookEntries(hooks.hooks.SubagentStop, [], isGdevHook);
    hooks.hooks.SubagentStart = replaceManagedHookEntries(hooks.hooks.SubagentStart, [], isGdevHook);
    hooks.hooks.PostToolUse = replaceManagedHookEntries(hooks.hooks.PostToolUse, [{
      matcher: "^(Agent|.*spawn_agent)$",
      hooks: [{ type: "command", command: runtimeCommand, timeout: 5, statusMessage: "Preparing GDEV handoff..." }],
    }], isGdevHook);
  }
  return {
    config,
    hooks: `${JSON.stringify(hooks, null, 2)}\n`,
    disabledSkillNames: [...stableSkills.keys()].sort(),
    disabledSkillLinks,
  };
}

async function installCodex(paths: RuntimePaths, setup: ResolvedSetup, prepared: PreparedCodex): Promise<void> {
  await removeLegacyNotifier(path.join(paths.codexHome, "notify.sh"));
  for (const link of prepared.disabledSkillLinks) await installSymlinkIdempotent(link.source, link.destination);
  const disabledSkillsRoot = path.join(paths.codexHome, "dev-disabled-skills");
  const activeLinks = new Set(prepared.disabledSkillLinks.map((link) => path.basename(link.destination)));
  try {
    for (const entry of await fs.readdir(disabledSkillsRoot, { withFileTypes: true })) {
      if (activeLinks.has(entry.name) || !entry.isSymbolicLink()) continue;
      await fs.unlink(path.join(disabledSkillsRoot, entry.name));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeChanged(path.join(paths.codexHome, "config.toml"), prepared.config);
  await writeChanged(path.join(paths.codexHome, "hooks.json"), prepared.hooks);
  await removeEntry(path.join(paths.codexHome, CODEX_MANAGED_HOOKS_FILE));
  if (setup.skills.has("codex")) {
    await retireLegacyGdevAgents(path.join(paths.codexHome, "agents"), "toml");
  }
  if (setup.relaxedPermissions) await copyChanged(RULES_SOURCE, path.join(paths.codexHome, "rules", "dev.rules"));
  if (setup.revokeRelaxedPermissions) {
    const rulesPath = path.join(paths.codexHome, "rules", "dev.rules");
    try {
      const existing = await fs.readFile(rulesPath, "utf8");
      const canonical = await fs.readFile(RULES_SOURCE, "utf8");
      if (existing === canonical || existing.includes("# Managed by dev setup")) await fs.unlink(rulesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function skillTargetRoot(paths: RuntimePaths, agent: InstructionAgent): string {
  return agent === "claude"
    ? path.join(paths.home, ".claude", "skills")
    : path.join(paths.home, ".agents", "skills");
}

async function installSkillsAndMemory(paths: RuntimePaths, setup: ResolvedSetup, prepared: PreparedSetup): Promise<void> {
  if (setup.skills.size) {
    for (const agent of setup.skills) {
      const targetRoot = skillTargetRoot(paths, agent);
      for (const skillName of prepared.skillNames) await installSymlinkIdempotent(path.join(SKILLS_DIR, skillName), path.join(targetRoot, skillName));
      const active = new Set(prepared.skillNames);
      for (const [staleName, recordedTarget] of prepared.previousSkillTargets.get(agent) ?? []) {
        if (active.has(staleName)) continue;
        const destination = path.join(targetRoot, staleName);
        try {
          if (!(await fs.lstat(destination)).isSymbolicLink()) continue;
          const currentTarget = path.resolve(path.dirname(destination), await fs.readlink(destination));
          if (currentTarget === path.resolve(recordedTarget)) await fs.unlink(destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const managedSkills = prepared.skillNames.map((name) => ({ name, target: path.join(SKILLS_DIR, name) }));
      await writeChanged(path.join(targetRoot, MANAGED_SKILLS_FILE), `${JSON.stringify({ skills: managedSkills }, null, 2)}\n`);
    }
  }
  const memoryTargets = getMemoryTargets(paths.home, paths.codexHome);
  for (const agent of setup.memory) await installSymlinkIdempotent(MEMORY_SOURCE, memoryTargets[agent]);
}

async function prepareSelectedSetup(paths: RuntimePaths, setup: ResolvedSetup): Promise<PreparedSetup> {
  const required: string[] = [];
  if (setup.terminal) {
    required.push(path.join(CONFIGS_DIR, "ghostty", paths.platform === "darwin" ? "config" : "config-common"));
    if (paths.platform === "linux") required.push(path.join(CONFIGS_DIR, "shell", "ghostty-ssh-truecolor.sh"));
  }
  if (setup.agents.has("claude")) required.push(
    path.join(CONFIGS_DIR, "claude", "statusline.sh"),
    path.join(CONFIGS_DIR, "claude", "settings.defaults.json")
  );
  if (setup.agents.has("codex")) required.push(path.join(CONFIGS_DIR, "codex", "config.defaults.toml"));
  if (setup.aliases) required.push(ALIASES_SOURCE);
  if (setup.skills.size) required.push(SKILLS_DIR);
  if (setup.skills.size) required.push(GDEV_RUNTIME);
  if (setup.memory.size) required.push(MEMORY_SOURCE);
  if (setup.relaxedPermissions || setup.revokeRelaxedPermissions) required.push(RULES_SOURCE);
  await Promise.all(required.map((source) => fs.access(source)));

  const prepared: PreparedSetup = { skillNames: [], previousSkillTargets: new Map() };
  if (setup.agents.has("claude")) prepared.claude = await prepareClaude(paths, setup);
  if (setup.agents.has("codex")) prepared.codex = await prepareCodex(paths, setup);
  if (setup.skills.size) {
    prepared.skillNames = setup.skillNames;
    for (const agent of setup.skills) {
      const manifest = await readJsonObject(path.join(skillTargetRoot(paths, agent), MANAGED_SKILLS_FILE));
      if (manifest.skills !== undefined && !Array.isArray(manifest.skills)) {
        throw new Error(`Cannot parse ${path.join(skillTargetRoot(paths, agent), MANAGED_SKILLS_FILE)}: skills must be an array.`);
      }
      const previousTargets = new Map<string, string>();
      for (const entry of manifest.skills ?? []) {
        if (typeof entry === "string") continue; // Legacy manifests did not record enough ownership data for safe deletion.
        if (!isPlainObject(entry) || typeof entry.name !== "string" || typeof entry.target !== "string") {
          throw new Error(`Cannot parse ${path.join(skillTargetRoot(paths, agent), MANAGED_SKILLS_FILE)}: each skill must contain string name and target fields.`);
        }
        previousTargets.set(entry.name, entry.target);
      }
      prepared.previousSkillTargets.set(agent, previousTargets);
    }
  }
  return prepared;
}

async function printSummary(setup: ResolvedSetup, paths: RuntimePaths, prepared: PreparedSetup): Promise<void> {
  console.log(chalk.bold("\nSetup selection:"));
  if (setup.terminal) {
    console.log("  Terminal destinations:");
    console.log(`    ${path.join(paths.configHome, "ghostty", "config")}`);
    if (paths.platform === "linux") console.log(`    ${shellConfig(paths)} (Ghostty SSH truecolor block)`);
  }
  if (setup.agents.has("claude")) {
    console.log("  Claude Code destinations:");
    for (const destination of [path.join(paths.home, ".claude", "settings.json"), path.join(paths.home, ".claude", "statusline.sh")]) console.log(`    ${destination}`);
    if (prepared.claude?.managedPermissions !== undefined) console.log(`    ${path.join(paths.home, ".claude", CLAUDE_MANAGED_PERMISSIONS_FILE)}`);
    if (setup.skills.has("claude")) console.log("    GDEV review/QA handoff hook (ordinary native subagents)");
  }
  if (setup.agents.has("codex")) {
    console.log("  Codex destinations:");
    for (const destination of [path.join(paths.codexHome, "config.toml"), path.join(paths.codexHome, "hooks.json")]) console.log(`    ${destination}`);
    if (setup.relaxedPermissions) console.log(`    ${path.join(paths.codexHome, "rules", "dev.rules")}`);
    if (setup.revokeRelaxedPermissions) console.log(`    remove managed rules: ${path.join(paths.codexHome, "rules", "dev.rules")}`);
    for (const link of prepared.codex?.disabledSkillLinks ?? []) console.log(`    ${link.destination} -> ${link.source}`);
    if (setup.skills.has("codex")) console.log("    GDEV review/QA handoff hook (ordinary native subagents)");
    if (setup.disableCodexSkills) {
      console.log("  Codex skills disabled:");
      for (const skillName of prepared.codex?.disabledSkillNames ?? []) console.log(`    - ${skillName}`);
    }
    console.log(setup.codexExtendedContext
      ? "  Codex context override: 400,000 tokens; auto-compact at 360,000"
      : "  Codex context override: not installed; a matching 400,000/360,000 pair will be removed, while custom values are preserved");
    console.log(setup.codexMaxSubagents
      ? `  Codex concurrent subagents: ${CODEX_MAX_CONCURRENT_SUBAGENTS}`
      : "  Codex concurrent subagents: existing setting preserved; Codex default applies if unset");
  }
  if (setup.skills.size) {
    console.log(`  Full repository skill bundle (${prepared.skillNames.length} installed):`);
    for (const skillName of prepared.skillNames) console.log(`    - ${skillName}`);
  }
  if (setup.skills.has("claude")) console.log(`  Claude skill destination: ${path.join(paths.home, ".claude", "skills")} (manifest: ${path.join(paths.home, ".claude", "skills", MANAGED_SKILLS_FILE)})`);
  if (setup.skills.has("codex")) console.log(`  Codex skill destination: ${path.join(paths.home, ".agents", "skills")} (manifest: ${path.join(paths.home, ".agents", "skills", MANAGED_SKILLS_FILE)})`);
  const memoryTargets = getMemoryTargets(paths.home, paths.codexHome);
  if (setup.memory.has("claude")) console.log(`  Claude global instructions: ${memoryTargets.claude}`);
  if (setup.memory.has("codex")) console.log(`  Codex global instructions: ${memoryTargets.codex}`);
  if (setup.aliases) {
    console.log(`  Shell aliases in ${shellConfig(paths)}:`);
    for (const alias of (await fs.readFile(ALIASES_SOURCE, "utf8")).trim().split("\n")) console.log(`    ${alias}`);
  }
  if (setup.relaxedPermissions) console.log(chalk.yellow("  Command approvals: allowlist only; publishing commands (git push, docker push/login, docker compose push, gh pr create) and destructive Git/Docker subcommands are unlisted; interpreters (python, node) and kill/pkill are approved, so this trusts the agent"));
}

export async function setupConfigs(options: SetupOptions = {}, runtime: SetupRuntime = {}): Promise<void> {
  const paths = runtimePaths(runtime);
  const setup = await resolveSetup(options, paths);
  if (!setup.terminal && setup.agents.size === 0) {
    console.log(chalk.dim("Nothing selected; no files changed."));
    return;
  }
  const prepared = await prepareSelectedSetup(paths, setup);
  await printSummary(setup, paths, prepared);
  if (paths.isTTY && !options.yes && !setup.reusedSavedSelection && !(await paths.prompts.confirm({ message: "Apply this setup?", default: true }))) {
    console.log(chalk.dim("Cancelled; no files changed."));
    return;
  }
  await retireLegacyTerminalConfig(paths);
  if (setup.terminal) await installTerminal(paths);
  if (setup.agents.has("claude")) await installClaude(paths, setup, prepared.claude!);
  if (setup.agents.has("codex")) await installCodex(paths, setup, prepared.codex!);
  if (setup.aliases) {
    await upsertFencedBlock(
      shellConfig(paths),
      "DEV AI ALIASES",
      await fs.readFile(ALIASES_SOURCE, "utf8")
    );
  }
  await installSkillsAndMemory(paths, setup, prepared);
  await writeChanged(savedSetupSelectionPath(paths), serializeSetupSelection(setup));
  console.log(chalk.dim(`  Saved setup selection: ${savedSetupSelectionPath(paths)}`));
  console.log(chalk.green("\nSetup complete."));
}
