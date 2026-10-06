# On-demand remote login

Read this reference completely before using the viewer. The user can request
noVNC/VNC directly. If cookie transfer completes but the destination remains
logged out, suggest the noVNC handoff instead of repeating the transfer.
Start it only after the user chooses this handoff.

## Resolve the handoff

Confirm the target SSH host, desktop user, dedicated browser profile, and site
from the current task. Reuse already confirmed information. This viewer
shares the existing Wayland desktop, including its other visible windows;
it does not isolate one browser tab or create a virtual desktop. Tell the
user this before starting. Do not start a second display or restart Chrome.

The helper runs on the user's **local machine**. When the agent runs locally,
start the viewer and SSH forwarding automatically after the user chooses this
handoff; do not ask them to assemble tunnels. If the agent runs remotely,
provide the local command for the user or an authorized local execution tool.
A remote loopback URL cannot be opened from a laptop without a local tunnel;
do not claim to have opened or forwarded it from a remote-only agent.

The remote needs a running Wayland desktop, WayVNC, Node.js 22+, and a working
systemd user manager. Node and WayVNC must be available in the SSH command's
PATH. SSH access must already work for the desktop user, including trusted
host keys and permission for local Unix-socket forwarding. Use the user's SSH
alias/config/key; do not alter sshd, Tailscale policy, or host-key checks to
make a connection work. On Omarchy, use its skill and `omarchy pkg add wayvnc`
if installation is needed. Other display platforms are unsupported by this
helper; report that rather than silently launching an extra desktop.

The local machine needs Node.js 22+, OpenSSH with multiplexing and Unix-socket
forwarding, `uv`, `curl`, and `tar`. The first start automatically downloads
checksum-pinned noVNC 1.7.0 and installs websockify 0.13.0 with uv into:

```
${XDG_CACHE_HOME:-$HOME/.cache}/browser-use/remote-view/novnc-1.7.0-websockify-0.13.0
```

This dependency cache is retained for later sessions. It contains no login
data and runs no background service. `BU_VIEW_CACHE_DIR` overrides the cache
root. `bu remote-view setup` prepares it ahead of a handoff. Stop all viewers
before removing that cache if the feature is abandoned. uv's shared download
cache may also retain packages; do not wipe unrelated cache contents.

## Start and log in

Keep the intended login page in a tab your session owns. A request for a
visible manual login handoff authorizes making **that owned tab** visible;
otherwise never activate unrelated tabs. Resolve or start the configured
remote browser with `bu chrome start` on that machine. For a local agent's
automation, use its real CDP port through a separately tracked loopback SSH
tunnel and `BU_CDP_URL`; never assume a fixed debugging port. Close that CDP
tunnel when its workflow ends.

Pause calls, cookie changes, recordings, and session sweeping on the shared
profile during human login. Coordinate with other agents using that profile;
session IDs separate tabs, not accounts. Do not end the login tab while the
user is working. The viewer itself never reads cookies or changes the browser
configuration.

Run locally, substituting the confirmed host and your unique session ID:

```bash
bu remote-view start --ssh USER@HOST --session root_login_a7c3
```

The helper automatically starts WayVNC, forwards its private Unix socket
through SSH, serves noVNC on a randomly allocated **127.0.0.1-only** local
port, and opens the URL in the normal local browser. No remote TCP VNC or
HTTP port is opened. The start command stays running until cleanup; use the
execution tool's background/running-session support and retain its handle.
Do not detach it with an untracked `nohup` command.

Optional arguments: `--ssh-port PORT`, `--identity PATH`, `--ssh-config PATH`,
`--no-open` (print the URL for manual opening), and `--lifetime SECONDS`
(30–3600, default 900). `--local` replaces `--ssh` when viewing this machine's
desktop from its own normal browser. These options do not launch a browser
profile or change remote SSH configuration.

The JSON output/status records the session, local port and URL, supervisor,
proxy/guardian/transport PIDs, remote WayVNC PID, remote transient unit and
socket, local runtime directory, and expiry. Keep those resource identifiers
in the task's cleanup inventory. An unopened viewer expires after 90 seconds
of proxy idleness; restart if the user misses the opening window.

The viewer URL contains a temporary access token in its fragment. Share it
only with the user and keep saved status private. WebSocket access requires
that token and the exact loopback viewer origin; a bare port is insufficient.
Dependency setup also uses a guarded process group and a three-minute limit,
so canceling a first start stops its installer descendants. Its guardian
continues across remote startup to clean local session files on supervisor loss.

Let the user enter credentials, choose an account, and complete MFA manually.
Never collect credentials or MFA codes.
Do not record or capture the desktop during this handoff. Treat the viewer's
connection as transport success, never as login success.

The desktop must be awake and able to focus the login window for input to
work. If rendering connects but input does not reach that window, check this
before declaring the handoff ready. Use the Omarchy skill for reversible
display/focus actions on Omarchy; leave OS unlocking to the user. Never type
into a desktop whose focused destination is uncertain.

## Stop and verify cleanup

After the user says they are done, or if the task is canceled or startup fails:

```bash
bu remote-view status --session root_login_a7c3
bu remote-view stop --session root_login_a7c3
```

Stop waits for the local supervisor to remove its owned state. Closing the
viewer also stops the session; reconnecting requires a fresh start. Ctrl-C
stops the foreground start command. The remote systemd unit owns WayVNC and
its sockets and has a hard lifetime limit; both remote worker and local proxy
guardian revoke their lease after 15 seconds without a supervisor heartbeat.
The proxy is a single process, so there are no detached worker forks to retain
its port. Only viewer resources are stopped; Chrome and the desktop remain.

Verify the recorded local port is closed, owned PIDs are gone, and the exact
remote unit is inactive with its runtime directory removed. Inspect by exact
resource names; never use broad `pkill`, delete unrelated sockets, or kill a
PID solely from stale state. A `status: unreachable` result is not successful
cleanup: allow the bounded lease to expire, then inspect recorded resources.
If a caller is forcibly killed before its first guardian can spawn, inspect
and remove only that session's stale state/runtime directory before reusing its ID.

Resume automation only after the user finishes and the viewer is stopped.
Verify the destination site's authenticated state from your owned tab, then
continue the original task. Follow the normal session cleanup when finished.
