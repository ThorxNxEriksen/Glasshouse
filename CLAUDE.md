# CLAUDE.md

## Project

**Glasshouse** — a public, shared analytics pipeline for how people use Claude Code (CLAUDE.md content, hooks, skills, MCP usage, time-per-permission-mode), captured via hooks and shipped to Supabase, with a Vercel-hosted dashboard for browsing.

MCP for Vercel/Supabase.

## Deployment

The dashboard is public: Vercel Authentication (`ssoProtection`) is deliberately **off**, so no login stands between a visitor and the dashboard. "Public" is the product, not an oversight — don't re-enable protection to fix a data-exposure concern.

The exposure control belongs one layer down: **each user decides how much of their own data they share.** Consent is per-user and per-category (the hook already gates `enabledPlugins` on an activity consent), so the dashboard must only ever render what a user has opted into sharing. When adding a field to the dashboard or a column to the pipeline, the question is not "is this domain protected" but "has this user consented to publishing this". Anything not covered by a consent must not reach a public view.

`frontend/vercel.json` pins `"framework": "nextjs"`. The Project Settings preset was "Other", which ran `next build` and then served only `frontend/public/` as static files — every app route returned a platform 404 while `/next.svg` returned 200. Keep the preset in `vercel.json`, not in dashboard state a checkout can't see.

## Supabase access

`.mcp.json` pins the Supabase MCP to `project_ref=smzccpjmakavoxlsrvku`
(**Glasshouse**, `eu-north-1`) — the project behind `frontend/.env.local`
and `glasshouse-plugin/glasshouse.mjs`.

The scope is the safety mechanism, not a convenience. `project_ref`
disables account-level tools, so there is no reachable path from this repo
to another project — a migration cannot land on the wrong database. Do not
"fix" an auth prompt by adding an unscoped `supabase` server at user scope
or re-enabling the `claude.ai Supabase` connector; both restore
account-wide reach. Re-authenticate the scoped entry instead: `/mcp`.

OAuth grants are keyed by the full URL including the query string, so
editing the ref always requires a fresh sign-in. That is expected.

MCP server config is machine-wide and lives in the **default** profile (`~/.claude.json`). `claude-work` and `claude-personal` overwrite their `mcpServers` key from it on every launch (`Sync-ClaudeMcpServers`), so a `claude mcp add`/`remove` run inside a profile session reports success and then silently reverts at next start. Change MCP servers in the default profile, or not at all.

## Reading data in the dashboard

Two failure modes here are silent — they produce plausible wrong numbers instead of an error:

- **PostgREST caps every response at 1000 rows**, whatever `.limit()` asks for. Never read a bare `.limit()` as "all rows". `ascending: true` therefore returned the *oldest* 1000 events and hid everything recent; the profile query now takes the newest window (`descending` + `limit(1000)`). That is a bound, not a fix: aggregates computed from the window read as lifetime figures while covering only the newest 1000 events — 23 of 41 sessions for one real account, and the window shrinks as usage grows. **Don't widen the fetch to compensate — aggregate server-side.** The page renders nothing finer than a session, so per-event rows should not reach the browser at all. See `backlog.md`.
- **`useParams()` returns the raw, still-percent-encoded segment.** Every email's `@` arrives as `%40`, and passing that to a query re-encodes it to `%2540`, matching nobody — which rendered *every* profile blank. Decode before querying.

## Capturing skill usage

**Read [`docs/recording_skills.md`](docs/recording_skills.md) before touching anything that reads or reports skill data.** It documents the observed payload shapes, what is verified vs. assumed, and how to re-verify after a Claude Code upgrade.

The two things that bite hardest:

- `tool_name` is the literal `"Skill"` for every skill invocation — never the skill's own name, which lives in `tool_input.skill` (→ the `skill_name` column). Believing otherwise is what made the pipeline discard every skill name for weeks.
- `tool_input.args` sits right beside the name and is **never** captured — it is free-text user content. A `--self-check` assertion enforces this; don't "fix" it.
- A plugin is not a skill. Each plugin injects exactly **one** entry-point skill at `SessionStart` (uncountable, recorded by name in `always_on_skills`); every other skill it ships is a normal `Skill` call already counted in `skill_name`. Believing "superpowers is always-on, so its skills are invisible" is wrong and cost a rewrite — the three tiers are in §8.

## The hook

**Read [`docs/hook.md`](docs/hook.md) before editing `glasshouse.mjs`.** It covers the two-copies problem and the exit invariant, both of which have already cost a debugging session each.

The two things that bite hardest:

- `glasshouse-plugin/glasshouse.mjs` is the distributed source, but the copy that **actually runs** is `~/.claude/hooks/glasshouse.mjs`, dropped by `install.mjs`. It is machine-wide, so a worktree does not isolate it — installing is not a local change. `diff` the two before assuming a fix is live.
- Hook mode must **not** call `process.exit()`, and `postEvent` must **not** use `fetch()`. Doing either aborts the hook on every tool call via libuv's `UV_HANDLE_CLOSING`. `--self-check` asserts both; don't "fix" them.
