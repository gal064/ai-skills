---
name: gdev_subagents
description: Orchestrate implementation across worktree subagents, choosing parallel/sequential waves, review ownership, and QA. User-invoked only.
argument-hint: [tasks or implementation plan]
disable-model-invocation: true
---

Orchestrate the requested implementation:

- Analyze dependencies and file overlap. Write the complete subagent implementation plan to Markdown, including the worktree and task breakdown, dependency waves, cycle and review ownership, required lightweight tests, each full-cycle worker's QA activity, and the final integrated QA. Get user alignment on the plan before starting any agent.
- Give every implementation agent its own git worktree, bounded task, acceptance criteria, model/effort, and required lightweight tests.
- Choose and state one mode for every task before dispatch:
  - **Full cycle:** launch an ordinary native implementation agent and tell it to load the canonical `gdev_cycle` skill from its absolute path. It owns the full cycle, including implementation, independent reviews (1–3 rounds for small/medium work, up to 5 for large work), applicable additional review types, its aligned QA activity, and its commit.
  - **Implementation only:** launch an ordinary native implementation agent. It owns implementation, its required lightweight tests, and its commit, but does not run a GDEV cycle. State which later agent owns review and QA before dispatch. Do not give it the `gdev_cycle` skill.
- Avoid duplicating worker-owned reviews at the root.
- Commit each stage and cycle. Keep the plan updated with status, commit hashes, and next steps so a new session can resume.
- Have each full-cycle worker complete implementation and review, launch the ordinary `gdev_qa`-labeled QA subagent required by `gdev_cycle`, and commit without pausing.
- Keep parallel-agent QA lightweight and isolated when shared environments or UI state could conflict; reserve integrated, heavy, or manual QA for the main agent after merging.
- Require each agent to finish and commit its work. Merge completed branches in dependency order, resolve integration issues, then launch a fresh ordinary subagent whose short description or task name starts with `gdev_qa` for one final end-to-end QA pass and report concrete results.

<instructions>$ARGUMENTS</instructions>
