# Install the `bu` integration

Read this file only after the user explicitly asks to install or reinstall this
skill. The upstream `browser-use` CLI is a prerequisite; do not install or
upgrade it as part of this workflow. `<skill-dir>` below is this skill's directory,
the folder containing SKILL.md and this file.

Installation configures one visible Chrome-family browser with a dedicated,
nonstandard user-data directory. Never configure the user's everyday Chrome
data directory as the automation destination.

## 1. Verify prerequisites and discover choices

Verify `browser-use`, Node.js 22 or newer, and `curl` exist. Node 22 is required
for the built-in WebSocket client used by cookie transfer. Stop and report a
missing prerequisite instead of installing it. Then run:

```bash
node <skill-dir>/scripts/discover-browser-config.mjs
```

Show the discovered browser names and executable paths, then ask which browser
to use. Show the discovered dedicated profiles and ask whether to reuse one or
create a new named profile. Treat the legacy `default-profile` as a valid
dedicated profile. For a new profile, default to:

```text
${XDG_CONFIG_HOME:-~/.config}/browser-use/profiles/NAME
```

Resolve both selections to exact absolute paths and repeat them back before
installing. Do not select between duplicate or similar choices yourself.

## 2. Install and start

Run the installer with the confirmed paths:

```bash
bash <skill-dir>/scripts/install.sh \
  --browser BROWSER_BINARY \
  --profile-dir DEDICATED_USER_DATA_DIR
```

The installer places the custom `bu` wrapper beside the resolved `browser-use`
command, writes owner-only machine configuration, and starts visible Chrome on
a dynamically selected CDP port.

No additional persistence setup is required. On Linux, `bu` uses the systemd
user manager when it is available; on macOS, app-bundled browsers are launched
through LaunchServices. These native launchers let the configured Chrome
survive after the calling Codex command exits, and every named `bu` session
shares that one Chrome while retaining its own tab. Other environments fall
back to a direct browser launch, which is suitable for ordinary terminal use
but may not survive an executor that reaps child processes between commands.

The `browser-use` package may already own a `bu` alias. The installer safely
replaces that known alias. If it reports an unrelated collision, show the exact
path and ask for confirmation. Only after confirmation, rerun the same command
with `--replace-bu`; the installer backs up the existing path first.

The installer also refuses to overwrite a configuration file it did not
generate. If it reports an unrelated config collision, show the exact path and
ask for separate confirmation. Only after confirmation, rerun with
`--replace-config`; the installer backs up that config first. Include both
replacement flags only when the user separately approved both collisions.

Do not stop, move, or relaunch an existing Chrome holding the selected profile.
If startup reports a profile lock, ask the user to close that exact dedicated
profile or choose another one.

Verify:

```bash
bu doctor
```

Then create an `about:blank` owned tab with a unique installation-check session,
print `page_info()`, close that owned tab, and clear that session with
`bu SESSION_ID --reload`. Do not interact with any existing tab.

## 3. Optional cookie seeding

After core installation succeeds, ask whether to:

1. Skip cookie transfer (recommended default).
2. Merge cookies for exact site domains.
3. Merge every source-profile cookie.

For all-cookie transfer, warn that this copies cookie-backed authentication for
every site in the selected source profile. Never copy localStorage, IndexedDB,
extensions, saved passwords, or history.

If the user opts in, read `references/cookie-transfer.md` completely. Confirm
the exact source browser/profile, destination dedicated profile, and domain
allowlist or explicit all-cookie scope. Assume the source already exposes CDP
and probe it; only if that probe fails, ask the user to enable remote debugging
inside the exact source Chrome profile and approve Chrome's permission prompt.
Then use the documented direct CDP-to-CDP transfer. If source CDP is unavailable
or ambiguous, skip seeding without failing installation.

## 4. Report

Report the selected browser, dedicated profile, wrapper location, connection
status, and cookie scope/counts if transfer was requested. Never report cookie
values. Mention that later `bu SESSION_ID` calls auto-start this configured
Chrome when it is stopped.
