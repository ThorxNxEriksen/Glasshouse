#!/bin/sh
# Glasshouse hook launcher — finds a Node runtime, then hands off to glasshouse.mjs.
#
# Why this exists: Claude Code's native installer and the Claude Desktop app ship one
# self-contained binary and no Node runtime, so "has Claude Code" stopped being evidence
# of "has node". A bare `node "...glasshouse.mjs"` hook command on such a machine prints
# a `hook error` with `node: command not found` into the transcript on EVERY tool call —
# loud, permanent, and useless. This script finds Node wherever it usually hides, and
# degrades to a single explanatory message when there genuinely is none.
#
# Shell form is deliberate: Claude Code runs shell-form hooks under `sh -c` on macOS and
# Linux, and under Git Bash on Windows, so this one file covers all three. (On Windows
# without Git Bash, shell-form hooks fall back to PowerShell and this script cannot run —
# see docs/installing_glasshouse.md. The Desktop Code tab requires Git for Windows, so
# desktop users are always covered.)
#
# No `set -e`/`set -u`: a hook must never break a session, and "$@" under `set -u` is
# unreliable in older shells. Every expansion below carries its own default instead.

# Parameter expansion rather than `dirname`, so the one thing that must work before we
# know anything about this machine does not itself depend on a PATH lookup.
case $0 in
  */*) DIR=${0%/*} ;;
  *)   DIR=. ;;
esac

# Highest installed version under a version manager's per-version directory layout.
# `sort -V` is GNU-only, so sort the dotted components numerically by hand.
newest_version_dir() {
  root=$1
  [ -d "$root" ] || return 1
  newest=$(ls "$root" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  [ -n "$newest" ] || return 1
  for prefix in v ""; do
    if [ -x "$root/$prefix$newest/bin/node" ]; then
      printf '%s\n' "$root/$prefix$newest/bin/node"
      return 0
    fi
  done
  return 1
}

# Prints "<origin>:<path>", where origin is `on-path` or `off-path`. The caller needs the
# distinction, and a subshell cannot hand back a second variable.
find_node() {
  # Test-only escape hatch. Any machine running --self-check has Node by definition, so
  # without this the no-Node branch below could never be exercised on the machine that
  # most needs to know it works.
  [ "${GLASSHOUSE_ASSUME_NO_NODE:-}" = "1" ] && return 1

  # PATH first — it respects whatever the user actually configured.
  for name in node nodejs; do
    if command -v "$name" >/dev/null 2>&1; then
      printf 'on-path:%s\n' "$(command -v "$name")"
      return 0
    fi
  done

  # Hooks run without the user's interactive shell profile, which is exactly why
  # version-manager installs go missing: nvm, fnm and volta all put node on PATH from
  # `.zshrc`/`.bashrc`, and a hook never sources those. Look directly.
  for candidate in \
    "${VOLTA_HOME:-${HOME:-}/.volta}/bin/node" \
    "${FNM_DIR:-${HOME:-}/.local/share/fnm}/aliases/default/bin/node" \
    "${HOME:-}/.local/share/fnm/aliases/default/bin/node" \
    "${HOME:-}/Library/Application Support/fnm/aliases/default/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "/c/Program Files/nodejs/node.exe" \
    "/c/Program Files (x86)/nodejs/node.exe" \
    "${LOCALAPPDATA:-${HOME:-}/AppData/Local}/Volta/bin/node.exe"
  do
    if [ -x "$candidate" ]; then
      printf 'off-path:%s\n' "$candidate"
      return 0
    fi
  done

  # nvm and fnm keep one directory per installed version with no "current" symlink that
  # resolves outside an interactive shell.
  for root in \
    "${NVM_DIR:-${HOME:-}/.nvm}/versions/node" \
    "${FNM_DIR:-${HOME:-}/.local/share/fnm}/node-versions"
  do
    found=$(newest_version_dir "$root") || continue
    printf 'off-path:%s\n' "$found"
    return 0
  done

  return 1
}

FOUND=$(find_node) || FOUND=""

if [ -n "$FOUND" ]; then
  ORIGIN=${FOUND%%:*}
  NODE=${FOUND#*:}

  # Exported only when Node is somewhere PATH will not find it. glasshouse.mjs drops this
  # into the set-email/consent commands it asks Claude to run: off PATH a bare `node`
  # would fail, but an absolute quoted path is not a runnable command in PowerShell,
  # which is what Claude reaches for on Windows. Off-PATH resolution is the nvm/fnm/volta
  # case and so effectively POSIX-only, which keeps the substitution where it is safe.
  if [ "$ORIGIN" = "off-path" ]; then
    GLASSHOUSE_NODE="$NODE"
    export GLASSHOUSE_NODE
  fi

  # exec, not a subshell: stdin passes through untouched and the process is replaced, so
  # nothing here can force an exit mid-teardown (see "How hook mode exits" in
  # docs/hook.md).
  exec "$NODE" "$DIR/glasshouse.mjs" "$@"
fi

# --- No Node on this machine -------------------------------------------------
# Exit 0 on every event so nothing breaks, and explain once at SessionStart. Once, not
# once per session: someone who has decided against installing Node should not be told
# again every time they open a session.

payload=$(cat)

printf '%s' "$payload" \
  | grep -q '"hook_event_name"[[:space:]]*:[[:space:]]*"SessionStart"' || exit 0

[ -n "${HOME:-}" ] || exit 0
marker_dir="$HOME/.claude/glasshouse"
marker="$marker_dir/node-missing-notified"
[ -f "$marker" ] && exit 0
mkdir -p "$marker_dir" 2>/dev/null && : > "$marker" 2>/dev/null

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Glasshouse is installed but found no Node.js runtime, so it is recording nothing. Claude Code bundles its own runtime and does not install Node, so having Claude Code is not enough. Tell the user, once and briefly, that Glasshouse needs Node.js 18 or newer (nodejs.org) and that the session must be restarted after installing it; then carry on with whatever they actually asked for. This notice is shown only once."}}'

exit 0
