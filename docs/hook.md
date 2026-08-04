# How the hook works

`glasshouse.mjs` is the whole capture side of Glasshouse: it reads the payload on
stdin, gates it against the repo's consent answers, and POSTs one row to
Supabase. This file documents the things about it that are easy to get wrong and
expensive to rediscover.

For what it captures from *skill* invocations specifically — payload shapes,
what is verified vs. assumed — see [`recording_skills.md`](recording_skills.md).
For prerequisites and how it is installed, see
[`installing_glasshouse.md`](installing_glasshouse.md).

---

## Claude Code does not invoke glasshouse.mjs

It invokes `glasshouse.sh`, which finds a Node runtime and `exec`s into
`glasshouse.mjs` beside it. Both `plugin.json` and the `settings.json` entries
`install.mjs` writes point at the launcher, never at the `.mjs` directly.

The launcher exists because Claude Code's native installer and the Claude Desktop
app ship one self-contained binary with their own runtime. "Has Claude Code" is
no longer "has node", and a bare `node "...glasshouse.mjs"` hook command on such
a machine prints a `hook error` with `node: command not found` into the
transcript on *every tool call*. So the launcher searches `PATH` and then the
usual nvm/fnm/volta/Homebrew/`Program Files` locations — hooks run without your
shell profile, which is exactly why version-manager installs go missing — and if
there is genuinely no Node it exits 0 and explains itself once at `SessionStart`.

Two consequences worth holding on to:

- When the launcher finds Node somewhere off `PATH` it exports `GLASSHOUSE_NODE`,
  and `buildSessionStartNotices` uses that absolute path in the `set-email` and
  `consent` commands it asks Claude to run. On `PATH`, it deliberately leaves the
  command as a bare `node`: Claude runs these through PowerShell on Windows,
  where a quoted string is a value rather than a command to execute.
- `sh` is now a requirement. Windows gets it from Git for Windows, which the
  desktop Code tab requires anyway; a Windows CLI user without Git Bash gets
  PowerShell for shell-form hooks and cannot run Glasshouse at all.

---

## Two files, two copies each

`glasshouse-plugin/glasshouse.mjs` and `glasshouse-plugin/glasshouse.sh` are the
distributed source, but `install.mjs` also drops standalone copies at
`~/.claude/hooks/`, and **those are what actually run** when `settings.json`
points there. Editing only the repo copy changes nothing about your own
telemetry.

The two have drifted in *both* directions before — the libuv
`UV_HANDLE_CLOSING` fix landed in one while `readInstructionsContent` and the
skill-name capture landed in the other. They were reconciled in `d5ec9f6`
(merge of `worktree-glasshouse-hook-uv-assert`), which took the union, and the
copies are byte-identical as of that commit. That is a snapshot, not a
guarantee: `diff` them before assuming a fix is live.

That installed copy is also machine-wide and shared by every session in every
repo, so a worktree does not isolate it. **Installing is not a local change.**

The hook detects drift itself: at `SessionStart`, when the session's cwd is
inside a checkout carrying `glasshouse-plugin/glasshouse.mjs`, it compares both
files against the copies actually executing and names whichever differ (line
endings alone don't count). If you see that warning, **diff them and keep the
union** — the drifted copy usually holds a real fix, so overwriting one with the
other loses work. Then `node install.mjs` to sync.

The launcher rots more quietly than the hook it launches: a stale `glasshouse.sh`
still starts *something*, so nothing looks wrong. That is why the drift check
covers it rather than only the `.mjs`.

---

## How hook mode exits

Hook mode must **not** call `process.exit()`, and `postEvent` must **not** use
`fetch()`. Both are enforced by `--self-check` assertions; don't "fix" them.

`fetch()`'s connection pool outlives the request, which is the only reason
forcing an exit ever looked necessary — and forcing one while the socket was
still closing is what aborted the hook with libuv's
`!(handle->flags & UV_HANDLE_CLOSING)` on *every* tool call. Deferring the exit
does not help (`setImmediate` and `setTimeout(0)` were both tried and both still
aborted); the teardown is not on the JS timer path. `node:http`/`https` with
`agent: false` has no pool to leak, so the loop drains on its own.

The abort cannot be reproduced offline: it needs a real remote socket **and** a
piped stdin (how Claude Code invokes hooks — feeding stdin from a file never
reproduces it). That is why the invariant is asserted directly instead of tested
behaviourally.

---

## The public view surface

Five `public_*` Supabase views (`public_user_directory`, `public_profile_events`,
`public_tool_totals`, `public_skill_totals`, `public_plugin_adoption` — see
`schema.sql`) are anon-readable and serve this data directly to unauthenticated
visitors. There is no RLS backstop on them: the base table blocks `anon` at the
grant level (insert-only), so these views run with the owner's privilege and
their column lists *are* the entire security boundary.

Any future change to what `sanitizeRaw`/`buildRow` puts into a row's `raw`
column must be re-audited against every one of these views, not just against
`claude_events`' own RLS policy. This is exactly the class of bug that produced
a live data leak in `public_profile_events.raw`: a denylist of top-level keys
missed a nested path (`tool_input.file_path`) and renamed top-level keys
(`trigger_file_path`, `parent_file_path`) that a later payload shape
introduced. The fix replaced the denylist with a whitelist for that reason —
but a whitelist still needs re-checking whenever a view's column list changes.

---

## Checking your changes

```bash
node glasshouse-plugin/glasshouse.mjs --self-check   # asserts the invariants above
node install.mjs --self-check                        # asserts the installed hook shape
diff glasshouse-plugin/glasshouse.mjs ~/.claude/hooks/glasshouse.mjs
diff glasshouse-plugin/glasshouse.sh  ~/.claude/hooks/glasshouse.sh
node install.mjs                                     # sync both live copies
```
