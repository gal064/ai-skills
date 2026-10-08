---
name: browser-use
description: "Use only when the user explicitly mentions using a browser or the browser-use CLI."
compatibility: "Requires the `browser-use` CLI and one-time `bu` setup."
---

# Browser Use

## Scope

If, and only if, the user explicitly asks to install or reinstall this skill's
`bu` integration, read `install.md` completely before acting. Do not read it
for ordinary browser work or connection failures.

A basic fetch of public information does not need browser automation. Prefer a
plain HTTP request or the available web-fetch tool for public pages, APIs, and
documentation. Use `bu` when the task needs interaction, the user's logged-in
session, JavaScript rendering, or a bot-protected page.

Translate the user's request directly into `bu` calls. Examples show syntax
only; never treat an example URL or action as the task. Do not run help, port
checks, or helper discovery first. If the user explicitly asks to connect to
their main browser, use the `browser-use` CLI directly and bypass the `bu`
wrapper and workflow; otherwise, use `bu`.

When running `bu` from Codex, execute every `bu` command with host permissions (`sandbox_permissions="require_escalated"`). `bu` requires access to files outside the sandbox.

Do not use this skill for logged-in social media or Google services without explicit user approval; automated activity could get the account banned. It is safe to use for B2B apps, logged-out sessions, and similar low-risk browsing.

For any cookie import, export, or transfer, read `references/cookie-transfer.md` completely before acting.

## Owned sessions and tabs

`bu` supplies the configured dedicated Chrome profile, runtime directory, and
live CDP endpoint automatically. Choose a unique session ID using your
canonical agent name plus a short suffix, with only letters, numbers, `_`, or
`-` (for example `root_research_a7c3`). It must start with a letter, number, or
`_`, run to at most 61 characters, and must not be `doctor`, `chrome`,
`recordings`, `video`, `telemetry`, `auth`, `skill`, `skill-dir`, or `remote-view`, which `bu`
answers as its own subcommands. Reuse that ID for every call in the
workflow; `bu` records the tabs that session owns and reattaches to them.
Different agents must use different IDs.

On the first call for a browser workflow, create a new owned tab:

```bash
bu root_research_a7c3 <<'PY'
owned_tab = new_tab()
# Perform only the browser actions the user requested.
print({'owned_tab': owned_tab, **page_info()})
PY
```

On later calls, pass the same ID without creating another tab; `bu` reattaches to the owned tab before running the code:

```bash
bu root_research_a7c3 <<'PY'
# Continue the user's requested work in the same tab.
print(page_info())
PY
```

Call `new_tab()` again whenever the workflow genuinely needs a second page; the
session owns every tab it opens. Switching to an unowned tab, such as a popup,
claims it, so ending the session closes it too. Tabs owned by another
session are refused, so handle a `PermissionError` by opening your own tab
rather than retrying. That
check covers the tab helpers and page targets only. It does not cover raw
`cdp(...)`, nor iframe targets from `iframe_target(...)`, which searches every
tab in the browser and can return a frame inside another session's page. Never
aim either at a page another session owns. Do not use `activate_tab` unless the user
explicitly asks to make a tab visible. Never run concurrent calls with the same
session ID: the two calls race two daemons onto one socket, and you get silent
wrong results plus a leaked daemon, not an error.

If a session's tabs are gone, the next call raises before your code runs; start
again with `new_tab()`.

Sessions separate tabs, not identities. Every session shares one Chrome and one
logged-in state, so cookies, storage, and signed-in accounts are common to all
of them; a separate session ID gives an agent its own tabs, never its own login.

The horse marker in the page title identifies the attached tab. Screenshots
and normal CDP input work on the attached background tab without visibly
switching Chrome tabs, though creating a tab may briefly change visible focus.

## Page workflow

Helpers are pre-imported and the daemon auto-starts. Common helpers include
`new_tab`, `goto_url`, `page_info`, `capture_screenshot`, `click_at_xy`,
`fill_input`, `type_text`, `press_key`, `scroll`, `wait_for_element`,
`wait_for_load`, `wait_for_network_idle`, `js`, `cdp`, `current_tab`, and
`close_tab`.

After navigation, call `wait_for_load()`. Use `wait_for_network_idle()` when a
JavaScript application continues loading or saving after the document load.

Prefer the accessibility tree for element targeting. It contains every
accessible role, name, and `backendDOMNodeId`; filter it before printing because
the full tree can contain thousands of nodes:

```python
nodes = cdp("Accessibility.getFullAXTree")["nodes"]
matches = []
for node in nodes:
    role = (node.get("role") or {}).get("value", "")
    name = (node.get("name") or {}).get("value", "")
    if role == "button" and name == "Submit":
        matches.append(node)
print(matches)
```

Resolve a selected accessibility node to viewport coordinates, click it, then
verify the expected result with a targeted `js(...)` or `page_info()` check:

```python
quad = cdp(
    "DOM.getBoxModel",
    backendNodeId=matches[0]["backendDOMNodeId"],
)["model"]["content"]
x = sum(quad[0::2]) / 4
y = sum(quad[1::2]) / 4
click_at_xy(x, y)
print(page_info())
```

Negative or oversized coordinates mean the target must be scrolled into view
first. Coordinate clicks are the default interaction mechanism and pass through
iframes, shadow DOM, and cross-origin surfaces at the compositor level.

Use `js(...)` for targeted DOM inspection or extraction, and as an interaction
fallback only when the accessibility tree lacks the element, such as canvas or
an exotic widget. Use a screenshot when layout or imagery matters. Do not dump
the entire DOM or accessibility tree when a targeted query will answer the
question.

Read the screenshot reference before translating screenshot positions into
click coordinates or capturing unusually large or full-page images.

When entering unusually long text, avoid slow per-character typing. Use the
fastest page-appropriate input method, then verify that the page retained the
exact value.

Login walls require user input. Existing signed-in SSO may be used
automatically, but stop for passwords, MFA, consent, or an ambiguous account
choice.

For remote browser login or noVNC/VNC requests, read
`references/remote-login.md` completely before acting.

Raw CDP is available through `cdp("Domain.method", ...)`. Use it when a normal
helper is insufficient, not as a reason to bypass the owned-tab model or invent
cross-frame JavaScript walkers.

Start with the normal `scroll(...)` helper. A scroll timeout is not permission
to foreground Chrome. Read the scrolling reference before retrying with focus
emulation, and call `activate_tab` only when the user explicitly asks to see the
tab.

## Recordings and videos

Fresh installs do not record. A natural request to record, show, demo, or make a
video opts the task into recording. Otherwise, do not enable it merely because
the browser work is substantial.

`BH_RECORD=1` or `BH_RECORD=0` overrides the saved recording preference for one
process.

The user can enable or disable local background traces with:

```bash
bu recordings enable
bu recordings disable
bu recordings
```

For an opted-in workflow, call `start_recording(name, title=...)` before browser
work, retain the exact returned directory, and call `stop_recording()` after
verification. For a request made after the task, use `bu recordings --latest`
only when its timestamps and pages match; never reenact completed work to create
a recording. Follow the video reference when producing a video.

## Advanced interaction references

When one of these mechanics is required, read the matching reference completely
before inventing an approach. The references document the underlying helpers;
continue executing all browser work through the same `bu SESSION_ID`.

- Dialogs: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/dialogs.md
- Downloads: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/downloads.md
- Drag and drop: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/drag-and-drop.md
- Dropdowns: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/dropdowns.md
- Iframes: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/iframes.md
- Cross-origin iframes: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/cross-origin-iframes.md
- Network requests: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/network-requests.md
- Print as PDF: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/print-as-pdf.md
- Screenshots: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/screenshots.md
- Scrolling: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/scrolling.md
- Shadow DOM: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/shadow-dom.md
- Uploads: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/uploads.md
- Viewport and emulation: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/viewport.md
- Video production: https://github.com/browser-use/browser-harness/blob/main/interaction-skills/make-video.md

## Cleanup

Do not clean up between calls that still need the tab state. When the workflow
is genuinely finished, end the session:

```bash
bu root_research_a7c3 --end
```

That closes every tab the session owns, stops its daemon, and clears its saved
state. `--reload` is an alias for `--end`. Every `bu` call that runs browser code also
ends any session idle longer than `BU_SESSION_TTL` seconds (default 3600; `0`
disables sweeping), so an abandoned workflow does not keep tabs open once the
tool is used again. Idle time runs from the start of a call, so keep the TTL
above the duration of your longest single call or a still-running session can
be swept. Reusing a session ID resumes its tabs while they still exist.

Do not move, copy, rename, stop, or relaunch the configured profile during
browser work. On failure, run `bu doctor`.
