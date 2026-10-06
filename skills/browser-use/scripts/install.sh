#!/usr/bin/env bash
set -euo pipefail
umask 077

resolve_link_target() {
  local source_path="$1"
  local source_dir link_target
  while [[ -L "$source_path" ]]; do
    source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
    link_target="$(readlink "$source_path")"
    if [[ "$link_target" = /* ]]; then
      source_path="$link_target"
    else
      source_path="$source_dir/$link_target"
    fi
  done
  source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
  printf '%s/%s\n' "$source_dir" "$(basename "$source_path")"
}

absolute_existing_file() {
  local target="$1"
  local target_dir
  target_dir="$(cd -P "$(dirname "$target")" && pwd)"
  printf '%s/%s\n' "$target_dir" "$(basename "$target")"
}

absolute_directory() {
  local target="$1"
  mkdir -p "$target"
  (cd -P "$target" && pwd)
}

absolute_directory_candidate() {
  local target="$1" parent
  if [[ -d "$target" ]]; then
    (cd -P "$target" && pwd)
    return
  fi
  parent="$(absolute_directory "$(dirname "$target")")"
  printf '%s/%s\n' "$parent" "$(basename "$target")"
}

is_within() {
  local candidate="$1" root="$2"
  [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]]
}

canonicalize_existing_directory() {
  local target="$1"
  if [[ -d "$target" ]]; then
    (cd -P "$target" && pwd)
  else
    printf '%s\n' "$target"
  fi
}

reject_everyday_profile() {
  local candidate="$1" chrome_config_root
  local standard_root
  chrome_config_root="${CHROME_CONFIG_HOME:-${XDG_CONFIG_HOME:-${HOME}/.config}}"
  local standard_roots=(
    "$chrome_config_root/google-chrome"
    "$chrome_config_root/chromium"
    "$chrome_config_root/chromium-browser"
    "$chrome_config_root/BraveSoftware/Brave-Browser"
    "$chrome_config_root/microsoft-edge"
    "${HOME}/Library/Application Support/Google/Chrome"
    "${HOME}/Library/Application Support/Google/Chrome Canary"
    "${HOME}/Library/Application Support/Chromium"
    "${HOME}/Library/Application Support/BraveSoftware/Brave-Browser"
    "${HOME}/Library/Application Support/Microsoft Edge"
  )
  for standard_root in "${standard_roots[@]}"; do
    standard_root="$(canonicalize_existing_directory "$standard_root")"
    if is_within "$candidate" "$standard_root"; then
      echo "browser-use install: refusing everyday Chrome profile path: $candidate" >&2
      echo "browser-use install: choose a dedicated nonstandard user-data directory" >&2
      return 1
    fi
  done
}

next_backup() {
  local target="$1" candidate="${1}.bak" suffix=1
  while [[ -e "$candidate" || -L "$candidate" ]]; do
    candidate="${target}.bak.${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s\n' "$candidate"
}

browser_binary=""
profile_dir=""
bin_dir=""
config_file=""
replace_bu=0
replace_config=0
skip_start=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --browser) browser_binary="${2:-}"; shift 2 ;;
    --profile-dir) profile_dir="${2:-}"; shift 2 ;;
    --bin-dir) bin_dir="${2:-}"; shift 2 ;;
    --config-file) config_file="${2:-}"; shift 2 ;;
    --replace-bu) replace_bu=1; shift ;;
    --replace-config) replace_config=1; shift ;;
    --skip-start) skip_start=1; shift ;;
    *) echo "browser-use install: unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$browser_binary" || -z "$profile_dir" ]]; then
  echo "usage: install.sh --browser PATH --profile-dir DIR [--bin-dir DIR] [--config-file FILE] [--replace-bu] [--replace-config]" >&2
  exit 2
fi
if ! command -v browser-use >/dev/null 2>&1; then
  echo "browser-use install: browser-use is not installed" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "browser-use install: Node.js 22 or newer is required" >&2
  exit 1
fi
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
  echo "browser-use install: Node.js 22 or newer is required (found $(node --version))" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "browser-use install: curl is required" >&2
  exit 1
fi
if [[ ! -x "$browser_binary" ]]; then
  echo "browser-use install: browser is not executable: $browser_binary" >&2
  exit 1
fi
case "$browser_binary$profile_dir$bin_dir$config_file" in
  *$'\n'*) echo "browser-use install: paths containing newlines are not supported" >&2; exit 1 ;;
esac

installer_path="$(resolve_link_target "${BASH_SOURCE[0]}")"
skill_dir="$(cd -P "$(dirname "$installer_path")/.." && pwd)"
wrapper="$skill_dir/bin/bu"
browser_binary="$(absolute_existing_file "$browser_binary")"
profile_dir="$(absolute_directory_candidate "$profile_dir")"
reject_everyday_profile "$profile_dir"

browser_use_command="$(command -v browser-use)"
browser_use_real="$(resolve_link_target "$browser_use_command")"
if [[ -z "$bin_dir" ]]; then
  bin_dir="$(dirname "$browser_use_command")"
fi
bin_dir="$(absolute_directory "$bin_dir")"
target="$bin_dir/bu"

collision=""
if [[ -e "$target" || -L "$target" ]]; then
  current_real="$(resolve_link_target "$target")"
  if [[ "$current_real" == "$wrapper" ]]; then
    collision="ours"
  elif [[ "$current_real" == "$browser_use_real" ]] ||
       { [[ -f "$target" ]] && cmp -s "$target" "$browser_use_real"; }; then
    collision="upstream"
  else
    collision="unrelated"
  fi
fi
if [[ "$collision" == "unrelated" && "$replace_bu" -ne 1 ]]; then
  echo "browser-use install: refusing to replace unrelated path: $target" >&2
  echo "browser-use install: confirm with the user, then rerun with --replace-bu" >&2
  exit 1
fi

if [[ -z "$config_file" ]]; then
  config_file="${XDG_CONFIG_HOME:-${HOME}/.config}/browser-use/bu.conf"
fi
config_parent="$(absolute_directory_candidate "$(dirname "$config_file")")"
config_file="$config_parent/$(basename "$config_file")"
config_collision=""
if [[ -e "$config_file" || -L "$config_file" ]]; then
  config_header=""
  if [[ -f "$config_file" && ! -L "$config_file" ]]; then
    IFS= read -r config_header < "$config_file" || true
  fi
  if [[ "$config_header" == "# Generated by the browser-use skill installer." ]]; then
    config_collision="ours"
  else
    config_collision="unrelated"
  fi
fi
if [[ "$config_collision" == "unrelated" && "$replace_config" -ne 1 ]]; then
  echo "browser-use install: refusing to replace unrelated config: $config_file" >&2
  echo "browser-use install: confirm with the user, then rerun with --replace-config" >&2
  exit 1
fi

profile_dir="$(absolute_directory "$profile_dir")"
printf 'managed-by=browser-use-skill\n' > "$profile_dir/.bu-dedicated-profile"
chmod 600 "$profile_dir/.bu-dedicated-profile"
if [[ "$collision" == "unrelated" ]]; then
  backup="$(next_backup "$target")"
  mv "$target" "$backup"
  echo "backed up: $target -> $backup"
fi
if [[ "$config_collision" == "unrelated" ]]; then
  config_backup="$(next_backup "$config_file")"
  mv "$config_file" "$config_backup"
  echo "backed up: $config_file -> $config_backup"
fi

link_tmp="$bin_dir/.bu.install.$$"
ln -s "$wrapper" "$link_tmp"
mv -f "$link_tmp" "$target"

config_parent="$(absolute_directory "$config_parent")"
config_file="$config_parent/$(basename "$config_file")"
config_tmp="$config_file.tmp.$$"
{
  printf '# Generated by the browser-use skill installer.\n'
  printf 'browser_binary=%s\n' "$browser_binary"
  printf 'profile_dir=%s\n' "$profile_dir"
} > "$config_tmp"
chmod 600 "$config_tmp"
mv -f "$config_tmp" "$config_file"

echo "installed: $target -> $wrapper"
echo "configured: $config_file"
echo "profile: $profile_dir"

if [[ "$skip_start" -eq 0 ]]; then
  BU_CONFIG_FILE="$config_file" "$target" chrome start
fi
