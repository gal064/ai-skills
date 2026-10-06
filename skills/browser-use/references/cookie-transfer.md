# In-memory cookie transfer

Use this workflow only after reading it completely. Cookies are authentication
material. Transfer them directly between live CDP endpoints; never write cookie
values to disk, logs, chat, or source control.

## Fast path

`sync-cookies.mjs` runs the whole workflow below in one command: it checks the
source profile, starts or finds the destination `bu` Chrome, opens and closes
the SSH tunnel, transfers in memory, and optionally checks a page:

```bash
node "$(bu skill-dir)/scripts/sync-cookies.mjs" \
  --domain example.com --profile person@example.com --to devbox \
  --check https://example.com/account --expect "Sign out"
```

- `--to` is an SSH host or `local`. Remote `bu` runs in a login shell, so a
  non-login PATH does not matter.
- `--profile` is required. It takes an account email or a profile directory such as
  `Profile 5`. Chrome's debug port serves only the profile Chrome opened with,
  so the flag checks that profile and refuses on a mismatch before reading any
  cookie; it cannot select another one.
- `--source-user-data-dir` defaults to macOS Google Chrome.
- `--check` reports the final URL and title. Only `--expect` text found in the
  page counts as evidence of login; without it the result says
  `loggedIn: unknown`, because a page that does not redirect is not proof.

When the user gives the domains, the destination, and the profile, that is the
scope confirmation. `--all` still needs the all-cookie warning below before you
run it. When you choose any of them yourself, confirm first as described below. Use the manual workflow when the fast path does not
fit, such as a source that is not a local user-data directory.

## Confirm scope first

Before reading or writing cookies, explicitly confirm:

1. Source machine, browser, and exact profile or live CDP endpoint.
2. Destination machine and exact dedicated profile or live CDP endpoint.
3. Either an exact normalized domain allowlist or an explicit request to copy
   every cookie. Never infer related domains.
4. Merge behavior. This workflow only merges matching cookie identities; it
   never clears destination cookies.

All-cookie transfer requires a specific warning that it copies authentication
for every cookie-backed site in the source profile. Site-scoped transfer is the
recommended default. State the resolved source, destination, and scope before
starting.

Cookie transfer may not establish authentication for sites that depend on
localStorage, IndexedDB, device binding, or another mechanism. Moving any
non-cookie storage requires separate explicit authorization.

## Make both profiles available through CDP

Resolve the configured dedicated destination with `bu chrome start`. It starts
the browser only if it is stopped, and prints the live endpoint either way:

```bash
bu chrome start
# running: http://127.0.0.1:39501
```

Pass that URL as `--destination-cdp-url`. Do not pass the destination profile
directory. `bu` keeps the authoritative endpoint in its own runtime directory,
while the `DevToolsActivePort` file inside the profile is left over from an
earlier launch; it routinely names a port that is dead, or one that another
process has since taken.

Assume an everyday Chrome source already exposes CDP, and probe it rather than
asking first:

```bash
curl -fsS --max-time 2 SOURCE_CDP_URL/json/version
```

For a `--source-user-data-dir` source, read the port from the first line of
`DevToolsActivePort` in that directory and probe `http://127.0.0.1:PORT`. A
resolved endpoint is not a live one: that file outlives the launch that wrote
it, so the probe is the only proof. Confirm the reported `Browser` matches the
expected source, in case another process has since taken the port.

Only when the probe fails, ask the user to open
`chrome://inspect/#remote-debugging` in the exact selected profile, enable
remote debugging for that browser instance, and approve Chrome's permission
prompt, then probe again. Do not attempt to bypass the prompt or copy the raw
profile database.

Either side accepts either endpoint form:

- A live HTTP CDP endpoint, such as the one `bu chrome start` prints or a local
  SSH-forwarded endpoint.
- A user-data directory whose `DevToolsActivePort` file was written by the
  browser currently running on it.

## Transfer directly in memory

For exact domains:

```bash
node "$(bu skill-dir)/scripts/transfer-cookies.mjs" \
  --source-user-data-dir SOURCE_USER_DATA_DIR \
  --destination-cdp-url DESTINATION_CDP_URL \
  --domain example.com
```

Repeat `--domain` only for separately confirmed suffixes. A cookie for
`sub.example.com` matches `example.com`; unrelated suffixes do not.

For an explicitly approved all-cookie transfer:

```bash
node "$(bu skill-dir)/scripts/transfer-cookies.mjs" \
  --source-user-data-dir SOURCE_USER_DATA_DIR \
  --destination-cdp-url DESTINATION_CDP_URL \
  --all
```

Use `--source-cdp-url` instead of `--source-user-data-dir` when the source is a
live or SSH-forwarded endpoint.

The script reads cookies from source CDP, filters them in memory, merges them
through destination CDP, and verifies every selected identity and value in
memory. It prints counts and scope only.

## SSH destination

First confirm the exact remote profile and CDP port without printing cookie
contents. Open an encrypted local tunnel in the background using an unused
local port, pass its loopback URL as the destination CDP URL, and close the
tunnel after verification. Cookie data remains inside the encrypted CDP
connection and is never copied to a temporary file.

## Verify

The imported and verified counts must match. This proves the destination
contains the selected cookie identities and values, not that the web account is
authenticated.

If authentication verification was requested, check it from a tab your own
session owns, following the skill's owned-tab model. Never drive or close a tab
another session owns; `bu` refuses those with a `PermissionError`.

```bash
bu root_cookiecheck_b410 <<'PY'
owned_tab = new_tab()
goto_url("https://example.com/")
wait_for_load()
print({'owned_tab': owned_tab, **page_info()})
PY
```

Read the resulting URL and title for a login redirect, then end the session,
which closes the tab it opened:

```bash
bu root_cookiecheck_b410 --end
```

When the transfer is part of a login task, verify authentication in the
destination's owned tab even when all cookie counts match. Device-bound
sessions may require a private key or other state that cookie transfer cannot
carry. If the destination remains logged out, suggest manual login through
the on-demand noVNC viewer and follow [remote-login.md](remote-login.md).
The user may choose noVNC directly and skip cookie transfer.

A CDP connection or transfer error is a transport/tool failure, not proof of
device binding. Report that distinction and fix the connection or offer
manual login without claiming cookie transfer established authentication.
