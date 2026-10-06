import { lstat, mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverInstallableSkills,
  getMemoryTargets,
  installSkillSymlinks,
  installSymlink,
} from "../src/commands/setup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("discoverInstallableSkills", () => {
  it("finds skill directories dynamically and sorts them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-setup-skills-"));
    temporaryDirectories.push(root);

    for (const skillName of ["zeta", "alpha"]) {
      await mkdir(path.join(root, skillName), { recursive: true });
      await writeFile(path.join(root, skillName, "SKILL.md"), `# ${skillName}\n`);
    }
    await mkdir(path.join(root, "not-a-skill"));

    await expect(discoverInstallableSkills(root)).resolves.toEqual(["alpha", "zeta"]);
  });
});

describe("getMemoryTargets", () => {
  it("uses Claude and Codex global instruction locations", () => {
    expect(getMemoryTargets("/home/example", "/custom/codex-home")).toEqual({
      claude: "/home/example/.claude/CLAUDE.md",
      codex: "/custom/codex-home/AGENTS.md",
    });
  });
});

describe("installSymlink", () => {
  it("backs up a directory symlink without following it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-setup-link-"));
    temporaryDirectories.push(root);
    const oldSource = path.join(root, "old-source");
    const newSource = path.join(root, "new-source");
    const dest = path.join(root, "installed-skill");
    await Promise.all([mkdir(oldSource), mkdir(newSource)]);
    await symlink(oldSource, dest);

    await installSymlink(newSource, dest);

    expect(await readlink(dest)).toBe(newSource);
    expect((await lstat(`${dest}.bak`)).isSymbolicLink()).toBe(true);
    expect(await readlink(`${dest}.bak`)).toBe(oldSource);
  });

  it("never overwrites an existing backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-setup-backup-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const dest = path.join(root, "config");
    await mkdir(source);
    await writeFile(dest, "original config");
    await writeFile(`${dest}.bak`, "user backup");

    await installSymlink(source, dest);

    expect(await readFile(`${dest}.bak`, "utf-8")).toBe("user backup");
    expect(await readFile(`${dest}.bak.1`, "utf-8")).toBe("original config");
    expect(await readlink(dest)).toBe(source);
  });
});

describe("installSkillSymlinks", () => {
  it("preserves an existing user-owned skill link when installing the discovered skill set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dev-setup-full-skills-"));
    temporaryDirectories.push(root);
    const sourceRoot = path.join(root, "source");
    const destRoot = path.join(root, "dest");
    await mkdir(path.join(sourceRoot, "alpha"), { recursive: true });
    await writeFile(path.join(sourceRoot, "alpha", "SKILL.md"), "# alpha\n");
    await mkdir(destRoot);
    const privateTarget = path.join(root, "private-skill");
    await symlink(privateTarget, path.join(destRoot, "private-skill"));

    const skillNames = await discoverInstallableSkills(sourceRoot);
    await installSkillSymlinks(sourceRoot, destRoot, skillNames);

    expect(await readlink(path.join(destRoot, "alpha"))).toBe(path.join(sourceRoot, "alpha"));
    expect(await readlink(path.join(destRoot, "private-skill"))).toBe(privateTarget);
  });
});