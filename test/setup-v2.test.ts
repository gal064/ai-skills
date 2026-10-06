import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISABLED_CODEX_SKILL_NAMES,
  mergeManagedPermissions,
  renderClaudeCommandPermissions,
  setTomlValue,
  setupConfigs,
  upsertFencedBlock,
  type SetupRuntime,
} from "../src/commands/setup.js";

const temporaryDirectories: string[] = [];
// Memory and aliases come from optional files that not every checkout has.
const itWithPrivateSources = it.skipIf(
  !existsSync(path.resolve("MEMORY.md")) || !existsSync(path.resolve("configs/shell/ai-aliases.sh"))
);

async function tempHome(): Promise<{ home: string; configHome: string; codexHome: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "dev-setup-v2-"));
  temporaryDirectories.push(home);
  return { home, configHome: path.join(home, ".config"), codexHome: path.join(home, ".codex") };
}

async function pathExists(target: string): Promise<boolean> {
  try { await (await import("node:fs/promises")).lstat(target); return true; } catch { return false; }
}

function occurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

function interactiveRuntime(runtime: Awaited<ReturnType<typeof tempHome>>) {
  const checkboxMock = vi.fn();
  const confirmMock = vi.fn();
  return {
    runtime: {
      ...runtime,
      platform: "linux" as const,
      isTTY: true,
      shell: "/bin/bash",
      prompts: {
        checkbox: checkboxMock as unknown as NonNullable<SetupRuntime["prompts"]>["checkbox"],
        confirm: confirmMock as unknown as NonNullable<SetupRuntime["prompts"]>["confirm"],
      },
    },
    checkboxMock,
    confirmMock,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("setup bundle isolation and idempotency", () => {
  it("installs only Ghostty files and creates no duplicates on rerun", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await setupConfigs({ terminal: true, yes: true }, runtime);
    const bashrc = path.join(runtime.home, ".bashrc");
    const firstBashrc = await readFile(bashrc, "utf8");

    expect(await readFile(path.join(runtime.configHome, "ghostty", "config"), "utf8")).toContain("copy-on-select = clipboard");
    expect(occurrences(firstBashrc, "# === START GHOSTTY SSH TRUECOLOR ===")).toBe(1);
    expect(await pathExists(path.join(runtime.home, ".claude"))).toBe(false);
    expect(await pathExists(runtime.codexHome)).toBe(false);

    await setupConfigs({ terminal: true, yes: true }, runtime);
    expect(await readFile(bashrc, "utf8")).toBe(firstBashrc);
    expect(await pathExists(`${bashrc}.bak`)).toBe(false);
  });

  itWithPrivateSources("installs Claude options, preserves unknown state and user skill links, and is byte-idempotent", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    const claudeHome = path.join(runtime.home, ".claude");
    await mkdir(path.join(claudeHome, "skills"), { recursive: true });
    await mkdir(path.join(claudeHome, "agents"), { recursive: true });
    await writeFile(path.join(claudeHome, "settings.json"), JSON.stringify({ unknown: { keep: true }, includeCoAuthoredBy: true, permissions: { allow: ["Read(user-file)", "Bash(git:*)", "Bash(docker:*)", "Bash(docker-compose:*)"] }, hooks: {
      Stop: [{ hooks: [{ type: "command", command: "custom" }] }, { hooks: [{ type: "command", command: '/bin/bash "/old/.claude/hooks/notify.sh" "Claude Code" "old"' }] }],
      Notification: [{ matcher: "permission_prompt", hooks: [{ type: "command", command: '/bin/bash "/old/.claude/hooks/notify.sh" "Claude Code" "old"' }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "custom-post" }] }, { matcher: "Agent", hooks: [{ type: "command", command: "node /old/gdev-runtime.js" }] }],
    } }, null, 2) + "\n");
    const privateSkillSource = path.join(runtime.home, "private-skill");
    await mkdir(privateSkillSource);
    await symlink(privateSkillSource, path.join(claudeHome, "skills", "private-skill"));
    const legacyAgentSource = path.join(runtime.home, "legacy-gdev-agent.md");
    await writeFile(legacyAgentSource, "legacy agent\n");
    await symlink(legacyAgentSource, path.join(claudeHome, "agents", "gdev-cycle-worker.md"));
    await writeFile(path.join(claudeHome, "agents", "gdev-qa.md"), "locally edited agent\n");
    await writeFile(path.join(claudeHome, "agents", "explorer.md"), "keep\n");

    const options = { ai: "claude", skills: "claude", memory: "claude", aliases: true, relaxedPermissions: true, unsafeMode: true, remoteControl: "claude", yes: true };
    await setupConfigs(options, runtime);
    const settingsPath = path.join(claudeHome, "settings.json");
    const firstSettings = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(firstSettings);
    expect(parsed.unknown).toEqual({ keep: true });
    expect(parsed.tui).toBe("fullscreen");
    expect(parsed.includeCoAuthoredBy).toBe(false);
    expect(parsed.model).toBeUndefined();
    expect(parsed.permissions.allow).toContain("Read(user-file)");
    expect(parsed.permissions.allow).toContain("Bash(git status:*)");
    expect(parsed.permissions.allow).not.toContain("Bash(git:*)");
    expect(parsed.permissions.allow).not.toContain("Bash(docker:*)");
    expect(parsed.permissions.ask).toBeUndefined();
    expect(parsed.permissions.allow).not.toContain("Bash(docker system:*)");
    expect(parsed.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: "custom" }] }]);
    expect(parsed.hooks.Notification).toBeUndefined();
    expect(parsed.hooks.SubagentStart).toEqual([]);
    expect(parsed.hooks.SubagentStop).toEqual([]);
    expect(parsed.hooks.PostToolUse).toEqual([
      expect.objectContaining({ matcher: "Bash" }),
      expect.objectContaining({ matcher: "Agent" }),
    ]);
    expect(JSON.stringify(parsed.hooks.PostToolUse)).toContain("gdev-runtime.js");
    expect(await pathExists(path.join(claudeHome, "agents", "gdev-cycle-worker.md"))).toBe(false);
    expect(await pathExists(path.join(claudeHome, "agents", "gdev-qa.md"))).toBe(false);
    expect(await readFile(path.join(claudeHome, "agents", "gdev-qa.md.bak"), "utf8")).toBe("locally edited agent\n");
    expect(await readFile(path.join(claudeHome, "agents", "explorer.md"), "utf8")).toBe("keep\n");
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
    expect(parsed.agentPushNotifEnabled).toBe(true);
    expect(await readlink(path.join(claudeHome, "skills", "private-skill"))).toBe(privateSkillSource);
    expect(await readlink(path.join(claudeHome, "CLAUDE.md"))).toBe(path.resolve("MEMORY.md"));
    expect(await pathExists(runtime.codexHome)).toBe(false);
    expect(occurrences(await readFile(path.join(runtime.home, ".bashrc"), "utf8"), "# === START DEV AI ALIASES ===")).toBe(1);

    await setupConfigs(options, runtime);
    expect(await readFile(settingsPath, "utf8")).toBe(firstSettings);
    expect(await pathExists(`${settingsPath}.bak.1`)).toBe(false);
    const bashrc = await readFile(path.join(runtime.home, ".bashrc"), "utf8");
    for (const alias of (await readFile(path.resolve("configs/shell/ai-aliases.sh"), "utf8")).trim().split("\n")) {
      expect(occurrences(bashrc, alias)).toBe(1);
    }
  });

  it("installs Codex defaults, plugin state, dynamic disabled skills, rules, and preserves unrelated files", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(path.join(runtime.codexHome, "rules"), { recursive: true });
    await writeFile(path.join(runtime.codexHome, "rules", "default.rules"), "user-rule\n");
    await writeFile(path.join(runtime.codexHome, "rules", "custom.rules"), "custom-rule\n");
    await writeFile(
      path.join(runtime.codexHome, "config.toml"),
      'model = "keep-me"\n\n[features]\nremote_plugin = true\n\n[projects."/private"]\ntrust_level = "trusted"\n\n[plugins."custom-plugin@example"]\nenabled = true\n\n[mcp_servers.node_repl]\ncommand = "node-repl"\n\n[mcp_servers."custom server"]\ncommand = "custom-server"\nenabled = true\n\n[mcp_servers.computer-use]\ncommand = "computer-use"\nenabled = true\n'
    );
    await writeFile(path.join(runtime.codexHome, "hooks.json"), JSON.stringify({ custom: true, hooks: { Stop: [
      { hooks: [{ type: "command", command: "custom" }] },
      { hooks: [{ type: "command", command: '/bin/bash "/opt/my-notifier/notify.sh"' }] },
      { hooks: [{ type: "command", command: '/bin/bash "/old/.codex/notify.sh"' }] },
    ] } }, null, 2) + "\n");
    const userSkill = path.join(runtime.home, "installed", "google-calendar");
    await mkdir(userSkill, { recursive: true });
    await writeFile(path.join(userSkill, "SKILL.md"), "# Google Calendar\n");
    await mkdir(path.join(runtime.home, ".agents", "skills"), { recursive: true });
    await symlink(userSkill, path.join(runtime.home, ".agents", "skills", "google-calendar"));
    const oldGeneratedPluginSkill = path.join(runtime.codexHome, "plugins", "cache", "browser", "9.0.0", "skills", "control-in-app-browser");
    const generatedPluginSkill = path.join(runtime.codexHome, "plugins", "cache", "browser", "10.0.0", "skills", "control-in-app-browser");
    for (const skillPath of [oldGeneratedPluginSkill, generatedPluginSkill]) {
      await mkdir(skillPath, { recursive: true });
      await writeFile(path.join(skillPath, "SKILL.md"), "# Browser\n");
    }
    const curatedPluginSkill = path.join(runtime.codexHome, "plugins", "cache", "openai-curated-remote", "gmail", "1.0.0", "skills", "gmail");
    await mkdir(curatedPluginSkill, { recursive: true });
    await writeFile(path.join(curatedPluginSkill, "SKILL.md"), "# Gmail\n");
    const bundledSkillNames = [
      "control-chrome",
      "computer-use",
      "visualize",
      "documents",
      "pdf",
      "presentations",
      "spreadsheets",
      "excel-live-control",
      "template-creator",
    ];
    const bundledSkillsRoot = path.join(runtime.codexHome, "plugins", "cache", "openai-bundled", "fixtures", "1.0.0", "skills");
    for (const skillName of bundledSkillNames) {
      const skillPath = path.join(bundledSkillsRoot, skillName);
      await mkdir(skillPath, { recursive: true });
      await writeFile(path.join(skillPath, "SKILL.md"), `# ${skillName}\n`);
    }
    const disabledSystemSkillNames = ["plugin-creator", "review-agent", "skill-creator", "skill-installer"];
    const enabledSystemSkillNames = ["imagegen", "openai-docs"];
    for (const skillName of [...disabledSystemSkillNames, ...enabledSystemSkillNames]) {
      const skillPath = path.join(runtime.codexHome, "skills", ".system", skillName);
      await mkdir(skillPath, { recursive: true });
      await writeFile(path.join(skillPath, "SKILL.md"), `# ${skillName}\n`);
    }
    const pluginManagementSkill = path.join(runtime.codexHome, "plugins", "cache", "openai-curated-remote", "plugin-management", "1.0.0", "skills", "plugin-management");
    await mkdir(pluginManagementSkill, { recursive: true });
    await writeFile(path.join(pluginManagementSkill, "SKILL.md"), "# Plugin Management\n");
    const sitesSkillsRoot = path.join(runtime.codexHome, "plugins", "cache", "openai-bundled", "sites", "1.0.0", "skills");
    for (const skillName of ["sites-building", "sites-hosting"]) {
      const skillPath = path.join(sitesSkillsRoot, skillName);
      await mkdir(skillPath, { recursive: true });
      await writeFile(path.join(skillPath, "SKILL.md"), `# ${skillName}\n`);
    }
    const managedLinks = path.join(runtime.codexHome, "dev-disabled-skills");
    await mkdir(managedLinks, { recursive: true });
    await symlink(userSkill, path.join(managedLinks, "stale"));
    await writeFile(path.join(managedLinks, "user-file"), "keep\n");

    const options = { ai: "codex", relaxedPermissions: true, remoteControl: "codex", yes: true };
    await setupConfigs(options, runtime);
    const configPath = path.join(runtime.codexHome, "config.toml");
    const firstConfig = await readFile(configPath, "utf8");
    expect(firstConfig).toContain('model = "keep-me"');
    expect(firstConfig).toContain('[projects."/private"]');
    expect(firstConfig).toContain("hooks = true");
    expect(firstConfig).toContain("apps = false");
    expect(firstConfig).toContain("remote_plugin = false");
    expect(firstConfig).toContain("remote_control = true");
    expect(firstConfig).toContain('[plugins."github@openai-curated-remote"]');
    expect(firstConfig).toContain('[plugins."slack@openai-curated-remote"]');
    expect(firstConfig).toContain('[plugins."visualize@openai-bundled"]');
    expect(firstConfig).toContain('[plugins."apollo@openai-curated"]');
    for (const plugin of [
      "browser@openai-bundled",
      "chrome@openai-bundled",
      "computer-use@openai-bundled",
      "documents@openai-primary-runtime",
      "pdf@openai-primary-runtime",
      "spreadsheets@openai-primary-runtime",
      "presentations@openai-primary-runtime",
      "template-creator@openai-primary-runtime",
      "codex-app-tools@openai-bundled",
      "custom-plugin@example",
    ]) {
      expect(firstConfig).toContain(`[plugins.${JSON.stringify(plugin)}]\nenabled = false`);
    }
    expect(firstConfig).toContain('[plugins."sites@openai-bundled"]\nenabled = true');
    const parsedConfig = parseToml(firstConfig);
    expect(parsedConfig.mcp_servers.node_repl).toEqual({ command: "node-repl" });
    expect(parsedConfig.mcp_servers["custom server"]).toEqual({ command: "custom-server", enabled: true });
    expect(parsedConfig.mcp_servers["computer-use"]).toEqual({ command: "computer-use", enabled: true });
    expect(firstConfig).not.toContain(path.join(runtime.home, ".agents", "skills", "google-calendar", "SKILL.md"));
    expect(firstConfig).toContain(path.join(runtime.codexHome, "dev-disabled-skills", "control-in-app-browser", "SKILL.md"));
    expect(firstConfig).toContain(path.join(runtime.codexHome, "dev-disabled-skills", "gmail", "SKILL.md"));
    expect(await readlink(path.join(managedLinks, "gmail"))).toBe(curatedPluginSkill);
    for (const skillName of bundledSkillNames) {
      expect(firstConfig).toContain(path.join(runtime.codexHome, "dev-disabled-skills", skillName, "SKILL.md"));
      expect(await readlink(path.join(managedLinks, skillName))).toBe(path.join(bundledSkillsRoot, skillName));
    }
    for (const skillName of disabledSystemSkillNames) {
      expect(firstConfig).toContain(path.join(runtime.codexHome, "skills", ".system", skillName, "SKILL.md"));
      expect(await pathExists(path.join(managedLinks, skillName))).toBe(false);
    }
    for (const skillName of enabledSystemSkillNames) {
      expect(firstConfig).not.toContain(path.join(runtime.codexHome, "skills", ".system", skillName, "SKILL.md"));
      expect(await pathExists(path.join(managedLinks, skillName))).toBe(false);
    }
    expect(firstConfig).toContain(path.join(runtime.codexHome, "dev-disabled-skills", "plugin-management", "SKILL.md"));
    expect(await readlink(path.join(managedLinks, "plugin-management"))).toBe(pluginManagementSkill);
    for (const skillName of ["sites-building", "sites-hosting"]) {
      expect(firstConfig).not.toContain(path.join(sitesSkillsRoot, skillName, "SKILL.md"));
      expect(await pathExists(path.join(managedLinks, skillName))).toBe(false);
    }
    expect(firstConfig).not.toContain(path.join(runtime.codexHome, "plugins", "cache"));
    expect(await readlink(path.join(runtime.codexHome, "dev-disabled-skills", "control-in-app-browser"))).toBe(generatedPluginSkill);
    expect(await pathExists(path.join(managedLinks, "stale"))).toBe(false);
    expect(await readFile(path.join(managedLinks, "user-file"), "utf8")).toBe("keep\n");
    expect(await readFile(path.join(runtime.codexHome, "rules", "default.rules"), "utf8")).toBe("user-rule\n");
    expect(await readFile(path.join(runtime.codexHome, "rules", "custom.rules"), "utf8")).toBe("custom-rule\n");
    expect(await readFile(path.join(runtime.codexHome, "rules", "dev.rules"), "utf8")).toContain('prefix_rule(pattern = ["git", "status"], decision = "allow")');
    const hooks = JSON.parse(await readFile(path.join(runtime.codexHome, "hooks.json"), "utf8"));
    expect(hooks.custom).toBe(true);
    expect(hooks.hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(hooks)).not.toContain("/old/.codex/notify.sh");
    expect(JSON.stringify(hooks)).toContain("/opt/my-notifier/notify.sh");

    await setupConfigs(options, runtime);
    expect(await readFile(configPath, "utf8")).toBe(firstConfig);
    expect(occurrences(firstConfig, "# BEGIN dev setup disabled skills")).toBe(1);
    expect(await pathExists(`${configPath}.bak.1`)).toBe(false);
  });

  it("installs and removes the fixed Codex context pair idempotently", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(runtime.codexHome, { recursive: true });
    await writeFile(
      path.join(runtime.codexHome, "config.toml"),
      'model = "keep-me"\nmodel_context_window = 123456\nmodel_auto_compact_token_limit = 100000\n'
    );
    const enabledOptions = { ai: "codex", disableCodexSkills: false, codexExtendedContext: true, yes: true };
    await setupConfigs(enabledOptions, runtime);
    const configPath = path.join(runtime.codexHome, "config.toml");
    const enabledConfig = await readFile(configPath, "utf8");
    expect(enabledConfig).toContain("model_context_window = 400000");
    expect(enabledConfig).toContain("model_auto_compact_token_limit = 360000");
    expect(enabledConfig).toContain('model = "keep-me"');

    await setupConfigs(enabledOptions, runtime);
    expect(await readFile(configPath, "utf8")).toBe(enabledConfig);
    expect(await pathExists(`${configPath}.bak.1`)).toBe(false);

    await setupConfigs({ ...enabledOptions, codexExtendedContext: false }, runtime);
    const disabledConfig = await readFile(configPath, "utf8");
    expect(disabledConfig).not.toContain("model_context_window");
    expect(disabledConfig).not.toContain("model_auto_compact_token_limit");
    expect(disabledConfig).toContain('model = "keep-me"');
  });

  it("installs the Codex GDEV handoff hook and retires legacy named agents", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(path.join(runtime.codexHome, "agents"), { recursive: true });
    await writeFile(path.join(runtime.codexHome, "agents", "gdev-code-review.toml"), "locally edited review agent\n");
    await writeFile(path.join(runtime.codexHome, "agents", "gdev-qa.toml"), "legacy QA agent\n");
    await writeFile(path.join(runtime.codexHome, "agents", "explorer.toml"), "keep\n");
    await writeFile(path.join(runtime.codexHome, "hooks.json"), JSON.stringify({ hooks: {
      SubagentStart: [{ matcher: "explorer", hooks: [{ type: "command", command: "custom-start" }] }],
      SubagentStop: [{ matcher: "explorer", hooks: [{ type: "command", command: "custom-stop" }] }, { matcher: "^gdev-", hooks: [{ type: "command", command: "node /old/gdev-runtime.js" }] }],
      PostToolUse: [{ matcher: "Agent", hooks: [{ type: "command", command: "node /old/gdev-runtime.js" }] }],
    } }));

    const options = { ai: "codex", skills: "codex", disableCodexSkills: false, yes: true };
    await setupConfigs(options, runtime);
    const hooksPath = path.join(runtime.codexHome, "hooks.json");
    const firstHooks = await readFile(hooksPath, "utf8");
    const hooks = JSON.parse(firstHooks).hooks;

    expect(hooks.SubagentStart).toEqual([
      expect.objectContaining({ matcher: "explorer" }),
    ]);
    expect(hooks.SubagentStop).toEqual([
      expect.objectContaining({ matcher: "explorer" }),
    ]);
    expect(hooks.PostToolUse).toEqual([
      expect.objectContaining({ matcher: "^(Agent|.*spawn_agent)$" }),
    ]);
    expect(JSON.stringify(hooks.PostToolUse)).toContain("gdev-runtime.js");
    expect(JSON.stringify(hooks)).not.toContain("GDEV_SKILLS_ROOT=");
    expect(await pathExists(path.join(runtime.codexHome, "agents", "gdev-code-review.toml"))).toBe(false);
    expect(await pathExists(path.join(runtime.codexHome, "agents", "gdev-qa.toml"))).toBe(false);
    expect(await readFile(path.join(runtime.codexHome, "agents", "gdev-code-review.toml.bak"), "utf8")).toBe("locally edited review agent\n");
    expect(await readFile(path.join(runtime.codexHome, "agents", "gdev-qa.toml.bak"), "utf8")).toBe("legacy QA agent\n");
    expect(await readFile(path.join(runtime.codexHome, "agents", "explorer.toml"), "utf8")).toBe("keep\n");

    await setupConfigs(options, runtime);
    expect(await readFile(hooksPath, "utf8")).toBe(firstHooks);
  });

  it("removes a transport-less Computer Use MCP stub on Linux", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(runtime.codexHome, { recursive: true });
    await writeFile(
      path.join(runtime.codexHome, "config.toml"),
      'model = "keep-me"\n\n[mcp_servers.computer-use]\nenabled = false\n'
    );

    const options = { ai: "codex", disableCodexSkills: false, yes: true };
    await setupConfigs(options, runtime);
    const firstConfig = await readFile(path.join(runtime.codexHome, "config.toml"), "utf8");
    const parsed = parseToml(firstConfig);

    expect(parsed.mcp_servers).toBeUndefined();
    expect(firstConfig).not.toContain("[mcp_servers.computer-use]");

    await setupConfigs(options, runtime);
    expect(await readFile(path.join(runtime.codexHome, "config.toml"), "utf8")).toBe(firstConfig);
  });

  it("disables an existing valid Computer Use MCP only on macOS", async () => {
    const runtime = { ...(await tempHome()), platform: "darwin" as const, isTTY: false, shell: "/bin/zsh" };
    await mkdir(runtime.codexHome, { recursive: true });
    await writeFile(
      path.join(runtime.codexHome, "config.toml"),
      '[mcp_servers.node_repl]\ncommand = "node-repl"\n\n[mcp_servers.computer-use]\ncommand = "computer-use"\nenabled = true\n'
    );

    await setupConfigs({ ai: "codex", disableCodexSkills: false, yes: true }, runtime);
    const parsed = parseToml(await readFile(path.join(runtime.codexHome, "config.toml"), "utf8"));

    expect(parsed.mcp_servers.node_repl).toEqual({ command: "node-repl" });
    expect(parsed.mcp_servers["computer-use"]).toEqual({ command: "computer-use", enabled: false });
  });

  it("sets the canonical Codex subagent limit and removes its legacy alias", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(runtime.codexHome, { recursive: true });
    await writeFile(
      path.join(runtime.codexHome, "config.toml"),
      'service_tier = "default"\n\n[agents]\nmax_concurrent_threads_per_session = 20\nmax_threads = 4\n\n[agents.reviewer]\ndescription = "Keep this role"\n'
    );

    const options = { ai: "codex", disableCodexSkills: false, codexMaxSubagents: true, yes: true };
    await setupConfigs(options, runtime);
    const configPath = path.join(runtime.codexHome, "config.toml");
    const firstConfig = await readFile(configPath, "utf8");
    const parsed = parseToml(firstConfig);

    expect(parsed.service_tier).toBeUndefined();
    expect(parsed.agents.max_concurrent_threads_per_session).toBe(10);
    expect(parsed.agents.max_threads).toBeUndefined();
    expect(parsed.agents.reviewer).toEqual({ description: "Keep this role" });

    await setupConfigs(options, runtime);
    expect(await readFile(configPath, "utf8")).toBe(firstConfig);
  });

  it("preserves existing Codex concurrency settings when the 10-subagent option is off", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(runtime.codexHome, { recursive: true });
    await writeFile(
      path.join(runtime.codexHome, "config.toml"),
      "[agents]\nmax_concurrent_threads_per_session = 20\nmax_threads = 6\n"
    );

    await setupConfigs({ ai: "codex", disableCodexSkills: false, codexMaxSubagents: false, yes: true }, runtime);
    const parsed = parseToml(await readFile(path.join(runtime.codexHome, "config.toml"), "utf8"));

    expect(parsed.agents.max_concurrent_threads_per_session).toBe(20);
    expect(parsed.agents.max_threads).toBe(6);
  });

  it("preserves partially customized Codex context values when the fixed pair is off", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(runtime.codexHome, { recursive: true });
    await writeFile(
      path.join(runtime.codexHome, "config.toml"),
      "model_context_window = 400000\nmodel_auto_compact_token_limit = 123456\n"
    );
    await setupConfigs({ ai: "codex", disableCodexSkills: false, codexExtendedContext: false, yes: true }, runtime);
    const config = await readFile(path.join(runtime.codexHome, "config.toml"), "utf8");
    expect(config).toContain("model_context_window = 400000");
    expect(config).toContain("model_auto_compact_token_limit = 123456");
  });

  it("rejects Codex context flags when Codex is not selected", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await expect(setupConfigs({ ai: "claude", codexExtendedContext: true, yes: true }, runtime)).rejects.toThrow("require Codex in --ai");
    await expect(setupConfigs({ ai: "claude", codexExtendedContext: false, yes: true }, runtime)).rejects.toThrow("require Codex in --ai");
  });

  it("rejects Codex subagent flags when Codex is not selected", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await expect(setupConfigs({ ai: "claude", codexMaxSubagents: true, yes: true }, runtime)).rejects.toThrow("require Codex in --ai");
    await expect(setupConfigs({ ai: "claude", codexMaxSubagents: false, yes: true }, runtime)).rejects.toThrow("require Codex in --ai");
  });

  itWithPrivateSources("saves an explicit machine selection and reuses it with one interactive confirmation", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await setupConfigs({
      terminal: true,
      ai: "codex",
      skills: "codex",
      memory: "codex",
      aliases: true,
      relaxedPermissions: true,
      remoteControl: "codex",
      disableCodexSkills: true,
      codexExtendedContext: true,
      codexMaxSubagents: true,
      yes: true,
    }, runtime);
    const selectionPath = path.join(runtime.configHome, "dev", "setup-selection.json");
    const saved = JSON.parse(await readFile(selectionPath, "utf8"));
    expect(saved).toMatchObject({
      version: 5,
      terminal: true,
      agents: ["codex"],
      skills: ["codex"],
      memory: ["codex"],
      aliases: true,
      relaxedPermissions: true,
      remoteControl: ["codex"],
      disableCodexSkills: true,
      codexExtendedContext: true,
      codexMaxSubagents: true,
    });

    const interactive = interactiveRuntime(runtime);
    interactive.confirmMock.mockResolvedValue(true);
    await setupConfigs({}, interactive.runtime);

    expect(interactive.confirmMock).toHaveBeenCalledTimes(1);
    expect(interactive.confirmMock.mock.calls[0]?.[0].message).toContain("Use this machine's saved setup selection");
    expect(interactive.checkboxMock).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(selectionPath, "utf8"))).toEqual(saved);
  });

  it("asks for both missing Codex choices when migrating a version-1 saved selection", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await setupConfigs({ ai: "codex", disableCodexSkills: false, yes: true }, runtime);
    const selectionPath = path.join(runtime.configHome, "dev", "setup-selection.json");
    const legacy = JSON.parse(await readFile(selectionPath, "utf8"));
    legacy.version = 1;
    delete legacy.codexExtendedContext;
    delete legacy.codexMaxSubagents;
    await writeFile(selectionPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const migration = interactiveRuntime(runtime);
    migration.confirmMock.mockImplementation(async ({ message }: { message: string }) => {
      if (message.startsWith("Use this machine's saved setup selection")) return true;
      if (message.startsWith("Configure Codex with a 400,000-token context window")) return true;
      if (message.startsWith("Configure Codex to allow up to 10 concurrent subagents")) return true;
      throw new Error(`Unexpected confirmation: ${message}`);
    });
    await setupConfigs({}, migration.runtime);

    expect(migration.confirmMock).toHaveBeenCalledTimes(3);
    expect(migration.confirmMock.mock.calls[1]?.[0].default).toBe(false);
    expect(migration.confirmMock.mock.calls[2]?.[0].default).toBe(true);
    const migrated = JSON.parse(await readFile(selectionPath, "utf8"));
    expect(migrated).toMatchObject({ version: 5, codexExtendedContext: true, codexMaxSubagents: true });
    const config = await readFile(path.join(runtime.codexHome, "config.toml"), "utf8");
    expect(config).toContain("model_context_window = 400000");
    expect(config).toContain("model_auto_compact_token_limit = 360000");
    expect(config).toContain("max_concurrent_threads_per_session = 10");

    const reused = interactiveRuntime(runtime);
    reused.confirmMock.mockResolvedValue(true);
    await setupConfigs({}, reused.runtime);
    expect(reused.confirmMock).toHaveBeenCalledTimes(1);
  });

  it("asks once for the Codex subagent choice when migrating a version-2 saved selection", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await setupConfigs({ ai: "codex", disableCodexSkills: false, codexMaxSubagents: false, yes: true }, runtime);
    const selectionPath = path.join(runtime.configHome, "dev", "setup-selection.json");
    const legacy = JSON.parse(await readFile(selectionPath, "utf8"));
    legacy.version = 2;
    delete legacy.codexMaxSubagents;
    await writeFile(selectionPath, `${JSON.stringify(legacy, null, 2)}\n`);
    await writeFile(path.join(runtime.codexHome, "config.toml"), "[agents]\nmax_concurrent_threads_per_session = 20\n");

    const migration = interactiveRuntime(runtime);
    migration.confirmMock.mockImplementation(async ({ message }: { message: string }) => {
      if (message.startsWith("Use this machine's saved setup selection")) return true;
      if (message.startsWith("Configure Codex to allow up to 10 concurrent subagents")) return false;
      throw new Error(`Unexpected confirmation: ${message}`);
    });
    await setupConfigs({}, migration.runtime);

    expect(migration.confirmMock).toHaveBeenCalledTimes(2);
    expect(migration.confirmMock.mock.calls[1]?.[0].default).toBe(true);
    expect(JSON.parse(await readFile(selectionPath, "utf8"))).toMatchObject({
      version: 5,
      codexMaxSubagents: false,
    });
    const config = parseToml(await readFile(path.join(runtime.codexHome, "config.toml"), "utf8"));
    expect(config.agents.max_concurrent_threads_per_session).toBe(20);

    const reused = interactiveRuntime(runtime);
    reused.confirmMock.mockResolvedValue(true);
    await setupConfigs({}, reused.runtime);
    expect(reused.confirmMock).toHaveBeenCalledTimes(1);
  });

  it("runs the installer again and replaces the saved selection when reuse is declined", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await setupConfigs({ ai: "codex", yes: true }, runtime);

    const interactive = interactiveRuntime(runtime);
    interactive.confirmMock.mockImplementation(async ({ message }: { message: string }) => {
      if (message.startsWith("Use this machine's saved setup selection")) return false;
      if (message === "Apply this setup?") return true;
      throw new Error(`Unexpected confirmation: ${message}`);
    });
    interactive.checkboxMock.mockImplementation(async ({ message }: { message: string }) => {
      if (message === "Choose setup bundles:") return ["terminal"];
      throw new Error(`Unexpected checkbox: ${message}`);
    });
    await setupConfigs({}, interactive.runtime);

    const saved = JSON.parse(await readFile(path.join(runtime.configHome, "dev", "setup-selection.json"), "utf8"));
    expect(saved).toMatchObject({ terminal: true, agents: [], disableCodexSkills: false });
  });

  it("migrates a version-4 saved selection that still lists OpenCode and tmux title sync", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await setupConfigs({ terminal: true, ai: "claude", yes: true }, runtime);
    const selectionPath = path.join(runtime.configHome, "dev", "setup-selection.json");
    const legacy = JSON.parse(await readFile(selectionPath, "utf8"));
    legacy.version = 4;
    legacy.agents = ["claude", "opencode"];
    legacy.tmuxTitleSync = true;
    await writeFile(selectionPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const reused = interactiveRuntime(runtime);
    reused.confirmMock.mockResolvedValue(true);
    await setupConfigs({}, reused.runtime);

    expect(reused.confirmMock).toHaveBeenCalledTimes(1);
    const migrated = JSON.parse(await readFile(selectionPath, "utf8"));
    expect(migrated).toMatchObject({ version: 5, terminal: true, agents: ["claude"] });
    expect(migrated.tmuxTitleSync).toBeUndefined();
  });

  it("retires legacy tmux, Fresh, lazygit, and notification files without touching user files", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    const configs = path.resolve("configs");
    const marker = "# Only send custom notifications inside tmux (worktree-cli sessions).\n";
    await mkdir(path.join(runtime.configHome, "fresh", "plugins"), { recursive: true });
    await mkdir(path.join(runtime.configHome, "lazygit"), { recursive: true });
    await mkdir(path.join(runtime.configHome, "opencode", "plugins"), { recursive: true });
    await mkdir(path.join(runtime.home, ".config", "dev"), { recursive: true });
    await mkdir(path.join(runtime.home, ".claude", "hooks"), { recursive: true });
    await mkdir(runtime.codexHome, { recursive: true });
    await symlink(path.join(configs, "tmux.conf"), path.join(runtime.home, ".tmux.conf"));
    await symlink(path.join(configs, "fresh", "config.json"), path.join(runtime.configHome, "fresh", "config.json"));
    await symlink(path.join(configs, "fresh", "themes"), path.join(runtime.configHome, "fresh", "themes"));
    await symlink(path.join(configs, "fresh", "plugins", "wt-open-explorer.ts"), path.join(runtime.configHome, "fresh", "plugins", "wt-open-explorer.ts"));
    await writeFile(path.join(runtime.configHome, "fresh", "plugins", "mine.ts"), "keep\n");
    await symlink(path.join(configs, "lazygit", "config.yml"), path.join(runtime.configHome, "lazygit", "config.yml"));
    await writeFile(path.join(runtime.home, ".config", "dev", "tmux-title-sync.conf"), "set-hook\n");
    await writeFile(path.join(runtime.home, ".claude", "hooks", "notify.sh"), marker);
    await writeFile(path.join(runtime.home, ".claude", "hooks", "custom.sh"), "keep\n");
    await writeFile(path.join(runtime.codexHome, "notify.sh"), marker);
    await writeFile(path.join(runtime.codexHome, ".dev-setup-managed-hooks.json"), "{}\n");
    await writeFile(path.join(runtime.configHome, "opencode", "plugins", "notification.js"), `// ${marker}`);

    await setupConfigs({ ai: "claude,codex", yes: true }, runtime);

    for (const removed of [
      path.join(runtime.home, ".tmux.conf"),
      path.join(runtime.configHome, "fresh", "config.json"),
      path.join(runtime.configHome, "fresh", "themes"),
      path.join(runtime.configHome, "fresh", "plugins", "wt-open-explorer.ts"),
      path.join(runtime.configHome, "lazygit", "config.yml"),
      path.join(runtime.home, ".config", "dev", "tmux-title-sync.conf"),
      path.join(runtime.home, ".claude", "hooks", "notify.sh"),
      path.join(runtime.codexHome, "notify.sh"),
      path.join(runtime.codexHome, ".dev-setup-managed-hooks.json"),
      path.join(runtime.configHome, "opencode", "plugins", "notification.js"),
    ]) expect(await pathExists(removed), removed).toBe(false);
    expect(await readFile(path.join(runtime.configHome, "fresh", "plugins", "mine.ts"), "utf8")).toBe("keep\n");
    expect(await readFile(path.join(runtime.home, ".claude", "hooks", "custom.sh"), "utf8")).toBe("keep\n");
  });

  it("keeps a user-owned tmux config that dev setup did not install", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await writeFile(path.join(runtime.home, ".tmux.conf"), "set -g mouse on\n");
    await setupConfigs({ ai: "claude", yes: true }, runtime);
    expect(await readFile(path.join(runtime.home, ".tmux.conf"), "utf8")).toBe("set -g mouse on\n");
  });

  it("asks whether to disable Codex skills and lists every managed skill in the install question", async () => {
    const base = await tempHome();
    const interactive = interactiveRuntime(base);
    interactive.confirmMock.mockImplementation(async ({ message }: { message: string }) => {
      if (message.startsWith("Disable these Codex skills?")) return false;
      if (message.startsWith("Configure Codex with a 400,000-token context window")) return false;
      if (message.startsWith("Configure Codex to allow up to 10 concurrent subagents")) return true;
      if (message === "Apply this setup?") return true;
      throw new Error(`Unexpected confirmation: ${message}`);
    });
    await setupConfigs({
      ai: "codex",
      skills: "",
      memory: "",
      aliases: false,
      relaxedPermissions: false,
      remoteControl: "",
    }, interactive.runtime);

    const disableQuestion = interactive.confirmMock.mock.calls.find(([question]) => question.message.startsWith("Disable these Codex skills?"))?.[0].message;
    expect(disableQuestion).toBeDefined();
    for (const skillName of DISABLED_CODEX_SKILL_NAMES) expect(disableQuestion).toContain(`  - ${skillName}`);
    expect(DISABLED_CODEX_SKILL_NAMES).toEqual(expect.arrayContaining([
      "plugin-creator",
      "review-agent",
      "skill-creator",
      "skill-installer",
      "plugin-management",
      "gmail",
      "google-calendar",
      "google-drive",
      "hubspot",
      "slack",
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
    ]));
    for (const enabledSkill of ["imagegen", "openai-docs", "sites-building", "sites-hosting"]) {
      expect(disableQuestion).not.toContain(`  - ${enabledSkill}`);
    }
    const saved = JSON.parse(await readFile(path.join(base.configHome, "dev", "setup-selection.json"), "utf8"));
    expect(saved.disableCodexSkills).toBe(false);
    expect(saved.codexExtendedContext).toBe(false);
    expect(saved.codexMaxSubagents).toBe(true);
    const contextQuestion = interactive.confirmMock.mock.calls.find(([question]) => question.message.startsWith("Configure Codex with a 400,000-token context window"))?.[0];
    expect(contextQuestion?.default).toBe(false);
    const subagentQuestion = interactive.confirmMock.mock.calls.find(([question]) => question.message.startsWith("Configure Codex to allow up to 10 concurrent subagents"))?.[0];
    expect(subagentQuestion?.default).toBe(true);
    const config = await readFile(path.join(base.codexHome, "config.toml"), "utf8");
    expect(config).not.toContain("# BEGIN dev setup disabled skills");
    expect(config).toContain("max_concurrent_threads_per_session = 10");
  });

  it("supports both bundles and all agents", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false };
    await setupConfigs({ terminal: true, ai: "claude,codex", yes: true }, runtime);
    expect(await pathExists(path.join(runtime.configHome, "ghostty", "config"))).toBe(true);
    expect(await pathExists(path.join(runtime.home, ".claude", "settings.json"))).toBe(true);
    expect(await pathExists(path.join(runtime.codexHome, "config.toml"))).toBe(true);
  });

  it("fails without explicit bundles in a non-interactive shell and writes nothing", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false };
    await expect(setupConfigs({}, runtime)).rejects.toThrow("requires --terminal and/or --ai");
    expect(await pathExists(path.join(runtime.configHome, "ghostty"))).toBe(false);
  });

  it("migrates the legacy Ghostty block without duplicating settings", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    const ghosttyPath = path.join(runtime.configHome, "ghostty", "config");
    const body = await readFile(path.resolve("configs/ghostty/config-common"), "utf8");
    await mkdir(path.dirname(ghosttyPath), { recursive: true });
    await writeFile(ghosttyPath, `user-setting = keep\n\n# Added by dev setup\n${body.trim()}\n`);
    await setupConfigs({ terminal: true, yes: true }, runtime);
    const migrated = await readFile(ghosttyPath, "utf8");
    expect(occurrences(migrated, "copy-on-select = clipboard")).toBe(1);
    expect(occurrences(migrated, "# === START DEV SETUP GHOSTTY ===")).toBe(1);
    expect(migrated).toContain("user-setting = keep");
  });

  it("prevalidates malformed AI files before writing anything", async () => {
    const claudeRuntime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(path.join(claudeRuntime.home, ".claude"), { recursive: true });
    await writeFile(path.join(claudeRuntime.home, ".claude", "settings.json"), "{broken");
    await expect(setupConfigs({ ai: "claude", yes: true }, claudeRuntime)).rejects.toThrow("Cannot parse");
    expect(await pathExists(path.join(claudeRuntime.home, ".claude", "statusline.sh"))).toBe(false);

    const codexRuntime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(codexRuntime.codexHome, { recursive: true });
    await writeFile(path.join(codexRuntime.codexHome, "config.toml"), "this is not toml\n");
    await expect(setupConfigs({ ai: "codex", yes: true }, codexRuntime)).rejects.toThrow("Cannot parse");
    expect(await readFile(path.join(codexRuntime.codexHome, "config.toml"), "utf8")).toBe("this is not toml\n");
    expect(await pathExists(path.join(codexRuntime.codexHome, "hooks.json"))).toBe(false);

    await writeFile(path.join(codexRuntime.codexHome, "config.toml"), "");
    await writeFile(path.join(codexRuntime.codexHome, "hooks.json"), "{broken");
    await expect(setupConfigs({ ai: "codex", yes: true }, codexRuntime)).rejects.toThrow("Cannot parse");
    expect(await readFile(path.join(codexRuntime.codexHome, "hooks.json"), "utf8")).toBe("{broken");
    expect(await readFile(path.join(codexRuntime.codexHome, "config.toml"), "utf8")).toBe("");
  });

  it("rejects incompatible hook container shapes before writing", async () => {
    for (const agent of ["claude", "codex"] as const) {
      const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
      const root = agent === "claude" ? path.join(runtime.home, ".claude") : runtime.codexHome;
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, agent === "claude" ? "settings.json" : "hooks.json"), JSON.stringify({ hooks: [] }));
      await expect(setupConfigs({ ai: agent, yes: true }, runtime)).rejects.toThrow("hooks must be a JSON object");
      expect(await pathExists(path.join(root, agent === "claude" ? "statusline.sh" : "config.toml"))).toBe(false);
    }
  });

  it("explicitly revokes only dev-managed Claude and Codex approvals", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    await mkdir(path.join(runtime.home, ".claude"), { recursive: true });
    await writeFile(path.join(runtime.home, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Read(user-file)"] } }));
    await setupConfigs({ ai: "claude,codex", relaxedPermissions: true, yes: true }, runtime);
    await setupConfigs({ ai: "claude,codex", revokeRelaxedPermissions: true, yes: true }, runtime);
    const settings = JSON.parse(await readFile(path.join(runtime.home, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Read(user-file)"]);
    expect(await pathExists(path.join(runtime.codexHome, "rules", "dev.rules"))).toBe(false);
  });

  it("drops previously managed ask entries and keeps user-owned ones", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    const claudeHome = path.join(runtime.home, ".claude");
    await mkdir(claudeHome, { recursive: true });
    await writeFile(path.join(claudeHome, "settings.json"), JSON.stringify({ permissions: { allow: ["Read(user-file)"], ask: ["Bash(docker system:*)", "Bash(user-tool:*)"] } }));
    await writeFile(path.join(claudeHome, ".dev-setup-managed-permissions.json"), JSON.stringify({ allow: [], ask: ["Bash(docker system:*)"] }));

    await setupConfigs({ ai: "claude", relaxedPermissions: true, yes: true }, runtime);
    const settings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    expect(settings.permissions.ask).toEqual(["Bash(user-tool:*)"]);
    expect(settings.permissions.allow).toContain("Bash(git status:*)");
    expect(JSON.parse(await readFile(path.join(claudeHome, ".dev-setup-managed-permissions.json"), "utf8")).ask).toBeUndefined();

    await writeFile(path.join(claudeHome, "settings.json"), JSON.stringify({ permissions: { allow: ["Read(user-file)"], ask: ["Bash(user-tool:*)"] } }));
    await setupConfigs({ ai: "claude", relaxedPermissions: true, yes: true }, runtime);
    expect(JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8")).permissions.ask).toEqual(["Bash(user-tool:*)"]);
  });

  it("reconciles only stale skill links recorded in the managed manifest", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    const root = path.join(runtime.home, ".claude", "skills");
    const source = path.join(runtime.home, "old-skill");
    const userSource = path.join(runtime.home, "user-skill-source");
    await mkdir(source, { recursive: true });
    await mkdir(userSource, { recursive: true });
    await mkdir(root, { recursive: true });
    await symlink(source, path.join(root, "removed-skill"));
    await symlink(userSource, path.join(root, "retargeted-skill"));
    await symlink(source, path.join(root, "user-skill"));
    await writeFile(path.join(root, ".dev-setup-managed-skills.json"), JSON.stringify({ skills: [
      { name: "removed-skill", target: source },
      { name: "retargeted-skill", target: source },
    ] }));
    await setupConfigs({ ai: "claude", skills: "claude", yes: true }, runtime);
    expect(await pathExists(path.join(root, "removed-skill"))).toBe(false);
    expect(await readlink(path.join(root, "retargeted-skill"))).toBe(userSource);
    expect(await pathExists(path.join(root, "user-skill"))).toBe(true);
  });

  itWithPrivateSources("prints exact destinations and complete alias commands before applying", async () => {
    const runtime = { ...(await tempHome()), platform: "linux" as const, isTTY: false, shell: "/bin/bash" };
    const generatedSkill = path.join(runtime.codexHome, "plugins", "cache", "browser", "2.0.0", "skills", "control-in-app-browser");
    await mkdir(generatedSkill, { recursive: true });
    await writeFile(path.join(generatedSkill, "SKILL.md"), "# Browser\n");
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...values) => output.push(values.join(" ")));
    await setupConfigs({ ai: "claude,codex", skills: "claude,codex", aliases: true, relaxedPermissions: true, yes: true }, runtime);
    const summary = output.join("\n");
    expect(summary).toContain(path.join(runtime.home, ".claude", "settings.json"));
    expect(summary).toContain(path.join(runtime.home, ".claude", ".dev-setup-managed-permissions.json"));
    expect(summary).toContain(path.join(runtime.codexHome, "rules", "dev.rules"));
    expect(summary).toContain(path.join(runtime.codexHome, "dev-disabled-skills", "control-in-app-browser"));
    expect(summary).toContain("Full repository skill bundle (");
    expect(summary).toContain("- context7");
    for (const alias of (await readFile(path.resolve("configs/shell/ai-aliases.sh"), "utf8")).trim().split("\n")) {
      expect(summary).toContain(alias);
    }
    expect(summary).toContain("Codex context override: not installed");
  });
});

describe("idempotent merge helpers", () => {
  it("removes stale managed permissions while preserving user permissions", () => {
    expect(mergeManagedPermissions(
      ["Read(user-file)", "Bash(old:*)", "Bash(current:*)"],
      ["Bash(old:*)", "Bash(current:*)"],
      ["Bash(current:*)", "Bash(new:*)"]
    )).toEqual(["Read(user-file)", "Bash(current:*)", "Bash(new:*)"]);
  });

  it("upserts one fenced block even when duplicates already exist", async () => {
    const { home } = await tempHome();
    const target = path.join(home, ".bashrc");
    const duplicate = "# === START TEST ===\nold\n# === END TEST ===\n";
    await writeFile(target, `${duplicate}\n${duplicate}`);
    await upsertFencedBlock(target, "TEST", "new");
    const once = await readFile(target, "utf8");
    await upsertFencedBlock(target, "TEST", "new");
    expect(await readFile(target, "utf8")).toBe(once);
    expect(occurrences(once, "# === START TEST ===")).toBe(1);
  });

  it("sets a TOML key once while preserving unrelated keys", () => {
    const first = setTomlValue("[features]\nunknown = true\nhooks = false\nhooks = false\n", "features", "hooks", "true");
    const second = setTomlValue(first, "features", "hooks", "true");
    expect(second).toBe(first);
    expect(occurrences(first, "hooks = true")).toBe(1);
    expect(first).toContain("unknown = true");
  });

  it("renders every canonical Codex prefix into a Claude permission", async () => {
    const rules = await readFile(path.resolve("configs/codex/rules/dev.rules"), "utf8");
    const prefixes = [...rules.matchAll(/prefix_rule\(pattern = (\[[^\]]+\]), decision = "allow"\)/g)].map((match) => JSON.parse(match[1]) as string[]);
    const permissions = renderClaudeCommandPermissions(prefixes);
    expect(permissions).toHaveLength(prefixes.length);
    expect(new Set(permissions).size).toBe(prefixes.length);
    expect(permissions).toContain("Bash(git status:*)");
    expect(permissions).not.toContain("Bash(git:*)");
    expect(permissions).not.toContain("Bash(docker:*)");
    expect(permissions).toContain("Bash(pwd)");
    // Codex still prompts on these; Claude gets an allowlist only, so they must stay out of it.
    const promptPrefixes = [...rules.matchAll(/prefix_rule\(pattern = (\[[^\]]+\]), decision = "prompt"/g)].map((match) => JSON.parse(match[1]) as string[]);
    for (const prompt of renderClaudeCommandPermissions(promptPrefixes)) expect(permissions).not.toContain(prompt);
  });
});
