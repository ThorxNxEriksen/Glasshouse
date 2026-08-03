# CLAUDE.md

## Project

**Glasshouse** — a public, shared analytics pipeline for how people use Claude Code (CLAUDE.md content, hooks, skills, MCP usage, time-per-permission-mode), captured via hooks and shipped to Supabase, with a Vercel-hosted dashboard for browsing.

MCP for Vercel/Supabase.

## Capturing skill usage

**Read [`docs/recording_skills.md`](docs/recording_skills.md) before touching anything that reads or reports skill data.** It documents the observed payload shapes, what is verified vs. assumed, and how to re-verify after a Claude Code upgrade.

The two things that bite hardest:

- `tool_name` is the literal `"Skill"` for every skill invocation — never the skill's own name, which lives in `tool_input.skill` (→ the `skill_name` column). Believing otherwise is what made the pipeline discard every skill name for weeks.
- `tool_input.args` sits right beside the name and is **never** captured — it is free-text user content. A `--self-check` assertion enforces this; don't "fix" it.

## Two copies of the hook

`glasshouse-plugin/glasshouse.mjs` is the distributed source, but `install.mjs` also drops a standalone copy at `~/.claude/hooks/glasshouse.mjs`, and **that is what actually runs** when settings.json points there. Editing only the repo copy changes nothing about your own telemetry. The two have drifted before (the libuv `UV_HANDLE_CLOSING` fix landed in one, `readInstructionsContent` in the other) — check `diff` between them before assuming a fix is live.

That installed copy is also machine-wide and shared by every session in every repo, so a worktree does not isolate it. Installing is not a local change.

The hook now detects this itself: at `SessionStart`, when the session's cwd is inside a checkout carrying `glasshouse-plugin/glasshouse.mjs`, it compares that file against the copy actually executing and warns if they differ (line endings alone don't count). If you see that warning, **diff the two and keep the union** — the drifted copy usually holds a real fix, so overwriting one with the other loses work. Then `node install.mjs` to sync.

## How hook mode exits

Hook mode must **not** call `process.exit()`, and `postEvent` must **not** use `fetch()`. Both are enforced by `--self-check` assertions; don't "fix" them.

`fetch()`'s connection pool outlives the request, which is the only reason forcing an exit ever looked necessary — and forcing one while the socket was still closing is what aborted the hook with libuv's `!(handle->flags & UV_HANDLE_CLOSING)` on *every* tool call. Deferring the exit does not help (`setImmediate` and `setTimeout(0)` were both tried and both still aborted); the teardown is not on the JS timer path. `node:http`/`https` with `agent: false` has no pool to leak, so the loop drains on its own.

The abort cannot be reproduced offline: it needs a real remote socket **and** a piped stdin (how Claude Code invokes hooks — feeding stdin from a file never reproduces it). That is why the invariant is asserted directly instead of tested behaviourally.
