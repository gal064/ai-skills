import { describe, it, expect } from "vitest";
import { validateBranchName, parseWorktreeList } from "../src/utils/git.js";

describe("validateBranchName", () => {
    it("accepts ordinary branch names, including slashes", () => {
        expect(validateBranchName("feature/login").isValid).toBe(true);
        expect(validateBranchName("main").isValid).toBe(true);
        expect(validateBranchName("release-1.2.3").isValid).toBe(true);
    });

    it("rejects empty or whitespace-only names", () => {
        expect(validateBranchName("").isValid).toBe(false);
        expect(validateBranchName("   ").isValid).toBe(false);
    });

    it("rejects names with whitespace or special characters", () => {
        expect(validateBranchName("bad name").isValid).toBe(false);
        expect(validateBranchName("foo~bar").isValid).toBe(false);
        expect(validateBranchName("foo:bar").isValid).toBe(false);
        expect(validateBranchName("foo?bar").isValid).toBe(false);
        expect(validateBranchName("foo[bar]").isValid).toBe(false);
    });

    it('rejects ".." and trailing ".lock"', () => {
        expect(validateBranchName("foo..bar").isValid).toBe(false);
        expect(validateBranchName("foo.lock").isValid).toBe(false);
    });

    it("rejects leading-dash (arg-injection) and other git-invalid forms", () => {
        expect(validateBranchName("-foo").isValid).toBe(false);
        expect(validateBranchName("--force").isValid).toBe(false);
        expect(validateBranchName(".foo").isValid).toBe(false);
        expect(validateBranchName("foo.").isValid).toBe(false);
        expect(validateBranchName("foo/").isValid).toBe(false);
        expect(validateBranchName("/foo").isValid).toBe(false);
        expect(validateBranchName("foo@{bar}").isValid).toBe(false);
    });
});

describe("parseWorktreeList", () => {
    it("marks the first entry as the main worktree", () => {
        const porcelain = [
            "worktree /repo",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /repo-feature",
            "HEAD def456",
            "branch refs/heads/feature",
            "",
        ].join("\n");

        const entries = parseWorktreeList(porcelain);
        expect(entries).toHaveLength(2);
        expect(entries[0].isMain).toBe(true);
        expect(entries[0].branch).toBe("main");
        expect(entries[1].isMain).toBe(false);
        expect(entries[1].branch).toBe("feature");
    });

    it("parses locked worktrees with and without a reason", () => {
        const porcelain = [
            "worktree /repo",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /repo-locked-bare",
            "HEAD def456",
            "branch refs/heads/locked-bare",
            "locked",
            "",
            "worktree /repo-locked-reason",
            "HEAD 789abc",
            "branch refs/heads/locked-reason",
            "locked in use by CI",
            "",
        ].join("\n");

        const entries = parseWorktreeList(porcelain);
        const bare = entries.find(e => e.branch === "locked-bare")!;
        const withReason = entries.find(e => e.branch === "locked-reason")!;

        expect(bare.locked).toBe(true);
        expect(bare.lockReason).toBeNull();
        expect(withReason.locked).toBe(true);
        expect(withReason.lockReason).toBe("in use by CI");
        expect(entries[0].locked).toBe(false);
    });

    it("parses detached and prunable flags", () => {
        const porcelain = [
            "worktree /repo",
            "HEAD abc123",
            "branch refs/heads/main",
            "",
            "worktree /repo-detached",
            "HEAD def456",
            "detached",
            "prunable gitdir file points to non-existent location",
            "",
        ].join("\n");

        const entries = parseWorktreeList(porcelain);
        const detached = entries[1];
        expect(detached.isDetached).toBe(true);
        expect(detached.isPrunable).toBe(true);
        expect(detached.branch).toBeNull();
    });
});
