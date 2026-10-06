---
name: gdev_cycle
description: Implement a plan, run independent review rounds, then run manual QA aligned with the user. User-invoked only.
argument-hint: [plan or implementation notes]
disable-model-invocation: true
---

Before starting, propose one manual-QA activity and get confirmation. If the user requests autonomous end-to-end execution, choose the QA and continue without pausing.

## 1. Implement

If the current branch is `develop` or `main`, switch to a new branch before making changes. Use a worktree only when requested or required by the plan.

Read the relevant context and implement the agreed plan completely.

## 2. Review — 1 reviewer by default; max 3 rounds (small/medium), 5 (large)

Start with one code reviewer. Name every review task `gdev_review_*`.

Launch each reviewer without inherited history (`fork_turns: "none"` in Codex; Claude Code starts fresh by default). Give it only:
- an explicit review anchor: uncommitted diff, commit, range, or `base...HEAD`
- the original user request
- relevant plans, requirements, and invariants

Tell code reviewers to load `diff-review`.

Never include implementer rationale, self-assessment, prior findings, or suggested fixes, and never ask a reviewer to "verify the fix."

**Triage findings conservatively.** Always choose the simplest correct solution, and avoid unjustified complexity and premature optimization like the plague.

- Fix verified, in-scope issues with meaningful user impact at the narrowest existing owner.
- Reject incorrect, repeated, cosmetic, speculative, or unaggravated pre-existing issues. Reject review-driven complexity unless it clearly and materially improves correctness, safety, or user behavior.
- Reassess when a finding comes from—or its fix would expand—a new mechanism. Trace the actual flow and compare repairing, narrowing, replacing, or removing it.

Findings and proposed fixes are opinions, not requirements. Never accept them in bulk.

Repeat a review type only when an accepted finding materially changes the code. Stop when findings repeat or lose material value. The caps are ceilings.

For large cross-system architecture, state-machine, pipeline, prompt/runtime, or framework changes, add an invariant reviewer covering:
- moved or removed guardrails and whether the new owner enforces them
- error paths, not only happy paths
- CLI/API/UI/runtime parity where relevant
- prompt/config/docs/test consistency
- tests validating invariants rather than encoding new assumptions
- unintended changes across legacy paths or variants

For major UI changes, add a design reviewer that renders the UI.

Run applicable review types in parallel initially.

## 3. Manual QA

After reviews settle, launch a fresh `gdev_qa_*` subagent for the agreed QA. Pure refactors and documentation may skip QA.

QA drives the change through its real surface: a browser flow, an endpoint with a realistic payload, a representative prompt, an end-to-end CLI run, or a migration against scratch data.

Use `browser-use` for visual frontend QA; prefer an existing component harness for small UI changes.

QA reports concrete observations, reproducible bugs, or blockers without editing source or making design decisions. The implementation owner handles the result. If QA cannot run, say so rather than claiming it passed. Honor explicit QA skips.

After implementation, review, and QA, commit only this cycle's changes.

<instructions>$ARGUMENTS</instructions>
