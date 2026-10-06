---
name: claude-codex-tmux
description: Use when reading or messaging Claude Code or Codex in tmux.
---

# Claude/Codex tmux

Use tmux to inspect Claude Code or Codex sessions; resolve the exact session, window, and pane from the user's prompt or align with the user, and verify you are targeting the same session before sending anything. Submit messages with Enter, never Tab unless the user explicitly asks to queue the message with Tab; after every send, wait five seconds, capture the pane, and confirm the message was actually submitted. If it was not submitted, press Enter again, wait five seconds, and verify again. When the user asks you to monitor, wait for the requested interval—or a reasonable few minutes if none is given—then inspect the pane and report whether a response arrived.