import fs from "node:fs";

const REVIEW_RETURN = `Reminder about the gdev_review results:

Review findings are opinions, not requirements. Never accept them in bulk. Before editing, classify each as Fix, Reject, or Reassess.

Always choose the simplest correct solution. Avoid unjustified complexity and premature optimization like the plague.

- Fix verified, in-scope issues with meaningful user impact.
- Reject incorrect, repeated, cosmetic, speculative, or unaffected pre-existing issues. Reject complexity unless it clearly and materially improves correctness, safety, or user behavior.
- Reassess when a finding comes from—or its fix would expand—a new mechanism. Trace the real flow and repair, narrow, replace, or remove the mechanism instead of patching symptoms.

Keep future reviews independent. Never pass them previous findings.`;

const QA_RETURN = `Reminder about the gdev_qa results:

Treat the report as evidence, not a design prescription. If QA passed, complete the remaining work. If it found a reproducible bug, trace the real flow and make the least complex correct change. If blocked, report the blocker rather than claiming success. Stay within the approved QA scope and continue autonomously unless new user authority is required.`;

function readInput() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function emitContext(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  }));
}

function invocationLabel(input, host) {
  const toolInput = input.tool_input;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";

  // Codex encrypts the delegated message, so its plaintext task_name is the
  // routing signal. Claude exposes the equivalent short description.
  const field = host === "codex" ? toolInput.task_name : toolInput.description;
  return typeof field === "string" ? field : "";
}

function handoffForLabel(label) {
  if (/^gdev_review(?:$|[\s:_-])/.test(label)) return REVIEW_RETURN;
  if (/^gdev_qa(?:$|[\s:_-])/.test(label)) return QA_RETURN;
  return null;
}

const input = readInput();
const host = process.argv[2] ?? "claude";

if (input.hook_event_name === "PostToolUse") {
  const handoff = handoffForLabel(invocationLabel(input, host));
  if (handoff) {
    emitContext(`Apply the following guidance when the delegated report is available. If it is already present in the tool result, apply it now.\n\n${handoff}`);
  }
}
