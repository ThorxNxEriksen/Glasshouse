# How the hook works

`glasshouse.mjs` is the whole capture side of Glasshouse: Claude Code invokes it
per event, it reads the payload on stdin, gates it against the repo's consent
answers, and POSTs one row to Supabase. This file documents the two things about
it that are easy to get wrong and expensive to rediscover.

For what it captures from *skill* invocations specifically — payload shapes,
what is verified vs. assumed — see [`recording_skills.md`](recording_skills.md).

---

## Two copies of the hook

`glasshouse-plugin/glasshouse.mjs` is the distributed source, but `install.mjs`
also drops a standalone copy at `~/.claude/hooks/glasshouse.mjs`, and **that is
what actually runs** when `settings.json` points there. Editing only the repo
copy changes nothing about your own telemetry.

The two have drifted in *both* directions before — the libuv
`UV_HANDLE_CLOSING` fix landed in one while `readInstructionsContent` and the
skill-name capture landed in the other. They were reconciled in `d5ec9f6`
(merge of `worktree-glasshouse-hook-uv-assert`), which took the union, and the
copies are byte-identical as of that commit. That is a snapshot, not a
guarantee: `diff` them before assuming a fix is live.

That installed copy is also machine-wide and shared by every session in every
repo, so a worktree does not isolate it. **Installing is not a local change.**

The hook now detects drift itself: at `SessionStart`, when the session's cwd is
inside a checkout carrying `glasshouse-plugin/glasshouse.mjs`, it compares that
file against the copy actually executing and warns if they differ (line endings
alone don't count). If you see that warning, **diff the two and keep the
union** — the drifted copy usually holds a real fix, so overwriting one with the
other loses work. Then `node install.mjs` to sync.

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

## Checking your changes

```bash
node glasshouse-plugin/glasshouse.mjs --self-check   # asserts the invariants above
diff glasshouse-plugin/glasshouse.mjs ~/.claude/hooks/glasshouse.mjs
node install.mjs                                     # sync the live copy
```
