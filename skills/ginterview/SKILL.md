---
name: ginterview
description: Interview the user in depth to create a detailed implementation spec.
argument-hint: [instructions]
disable-model-invocation: true
---

Follow the user instructions and interview them in detail to produce a complete spec.

Keep asking non-obvious questions about:
- scope and exclusions
- UX and workflows
- constraints and tradeoffs
- rollout and validation
- failure modes and edge cases

Do not stop at obvious clarification. Keep interviewing until the spec is decision complete, then write the resulting spec to a file.

<instructions>$ARGUMENTS</instructions>
