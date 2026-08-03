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
