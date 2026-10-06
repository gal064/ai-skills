import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const runtime = path.join(root, "configs", "hooks", "gdev-runtime.js");

async function runHook(input: Record<string, unknown>, host = "claude") {
  const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("node", [runtime, host], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`hook exited ${code}: ${stderr}`)));
    child.stdin.end(JSON.stringify(input));
  });
  expect(stderr).toBe("");
  return stdout ? JSON.parse(stdout) : null;
}

describe("GDEV handoff hook", () => {
  it("routes Claude review and QA descriptions", async () => {
    const review = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { description: "gdev_review code changes", prompt: "Review the diff" },
    });
    const qa = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { description: "gdev_qa: CLI flow", prompt: "Run QA" },
    });

    expect(review.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(review.hookSpecificOutput.additionalContext).toContain("Reminder about the gdev_review results");
    expect(review.hookSpecificOutput.additionalContext).toContain("simplest correct solution");
    expect(qa.hookSpecificOutput.additionalContext).toContain("Reminder about the gdev_qa results");
    expect(qa.hookSpecificOutput.additionalContext).toContain("least complex correct change");
  });

  it("routes Codex task names even when the delegated message is encrypted", async () => {
    const review = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "collaborationspawn_agent",
      tool_input: { task_name: "gdev_review_code_1", message: "gAAAA-encrypted" },
    }, "codex");
    const qa = await runHook({
      hook_event_name: "PostToolUse",
      tool_name: "spawn_agent",
      tool_input: { task_name: "gdev_qa_cli", message: "gAAAA-encrypted" },
    }, "codex");

    expect(review.hookSpecificOutput.additionalContext).toContain("Reminder about the gdev_review results");
    expect(qa.hookSpecificOutput.additionalContext).toContain("Reminder about the gdev_qa results");
  });

  it("supports review labels for code, invariant, and design reviewers", async () => {
    for (const label of ["gdev_review_code", "gdev_review-invariant", "gdev_review:design"]) {
      const output = await runHook({
        hook_event_name: "PostToolUse",
        tool_input: { task_name: label },
      }, "codex");
      expect(output.hookSpecificOutput.additionalContext).toContain("Reminder about the gdev_review results");
    }
  });

  it("stays silent for missing, unrelated, or near-match labels", async () => {
    for (const taskName of [undefined, "explore", "my_gdev_review", "gdev_reviewer", "gdev_quality"]) {
      expect(await runHook({
        hook_event_name: "PostToolUse",
        tool_input: taskName === undefined ? {} : { task_name: taskName },
      }, "codex")).toBeNull();
    }
    expect(await runHook({
      hook_event_name: "PostToolUse",
      tool_input: { description: "ordinary review" },
    })).toBeNull();
  });

  it("ignores non-PostToolUse events", async () => {
    expect(await runHook({
      hook_event_name: "SubagentStart",
      tool_input: { description: "gdev_review code" },
    })).toBeNull();
  });
});
