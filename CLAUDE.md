# CLAUDE.md

## Project

**Glasshouse** — a public, shared analytics pipeline for how people use Claude Code (CLAUDE.md content, hooks, skills, MCP usage, time-per-permission-mode), captured via hooks and shipped to Supabase, with a Vercel-hosted dashboard for browsing.

MCP for Vercel/Supabase.

## Deployment

The dashboard is public: Vercel Authentication (`ssoProtection`) is deliberately **off**, so no login stands between a visitor and the dashboard. "Public" is the product, not an oversight — don't re-enable protection to fix a data-exposure concern.

The exposure control belongs one layer down: **each user decides how much of their own data they share.** Consent is per-user and per-category (the hook already gates `enabledPlugins` on an activity consent), so the dashboard must only ever render what a user has opted into sharing. When adding a field to the dashboard or a column to the pipeline, the question is not "is this domain protected" but "has this user consented to publishing this". Anything not covered by a consent must not reach a public view.

`frontend/vercel.json` pins `"framework": "nextjs"`. The Project Settings preset was "Other", which ran `next build` and then served only `frontend/public/` as static files — every app route returned a platform 404 while `/next.svg` returned 200. Keep the preset in `vercel.json`, not in dashboard state a checkout can't see.

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
