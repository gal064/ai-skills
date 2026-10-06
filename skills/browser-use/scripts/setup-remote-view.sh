#!/usr/bin/env bash
set -euo pipefail
umask 077
# Only dependency files are cached. No service is installed or enabled.
cache_root="${BU_VIEW_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-use/remote-view}"
version_dir="$cache_root/novnc-1.7.0-websockify-0.13.0"
if [[ -f "$version_dir/ready" && -f "$version_dir/novnc/vnc.html" && -x "$version_dir/venv/bin/websockify" ]]; then
  printf '%s\n' "$version_dir"
  exit 0
fi
command -v uv >/dev/null || { echo 'remote-view: uv is required on the local machine' >&2; exit 1; }
command -v curl >/dev/null || { echo 'remote-view: curl is required on the local machine' >&2; exit 1; }
mkdir -p "$cache_root"
[[ ! -L "$cache_root" && -O "$cache_root" ]] || { echo 'remote-view: unsafe cache directory' >&2; exit 1; }
chmod 700 "$cache_root"
lock="$cache_root/setup.lock"
mkdir "$lock" 2>/dev/null || { echo "remote-view: setup already running; retry after it finishes ($lock)" >&2; exit 1; }
build=""
cleanup() {
  [[ -z "$build" ]] || rm -rf -- "$build"
  [[ -f "$version_dir/ready" ]] || rm -rf -- "$version_dir"
  rmdir "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
build="$(mktemp -d "$cache_root/.setup.XXXXXX")"
curl -fsSL --connect-timeout 10 --max-time 60 \
  https://codeload.github.com/novnc/noVNC/tar.gz/refs/tags/v1.7.0 -o "$build/novnc.tar.gz"
node -e '
  const fs = require("node:fs"), crypto = require("node:crypto");
  const actual = crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex");
  if (actual !== "b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6") {
    console.error("remote-view: noVNC archive checksum mismatch"); process.exit(1);
  }
' "$build/novnc.tar.gz"
tar -xzf "$build/novnc.tar.gz" -C "$build"
mv "$build/noVNC-1.7.0" "$build/novnc"
rm "$build/novnc.tar.gz"
# venv entrypoints contain their absolute path, so create it at its final path.
rm -rf -- "$version_dir"
mkdir -p "$version_dir"
mv "$build/novnc" "$version_dir/novnc"
uv venv "$version_dir/venv" >&2
uv pip install --python "$version_dir/venv/bin/python" 'websockify==0.13.0' >&2
touch "$version_dir/ready"
printf '%s\n' "$version_dir"
