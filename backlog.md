# Backlog

Known work, not yet done. Newest concerns first. Keep entries short and say *why*,
not just what — a line nobody can act on is worse than no line.

---

## 1. Aggregate server-side; stop shipping raw events to the browser

**Why now.** The profile page fetches raw `claude_events` rows and aggregates in the
client. PostgREST caps every response at 1000 rows, so the page can only ever see a
window, and every "total" it renders is really "total within the newest 1000 events".
For one real account that is **23 of 41 sessions**, and the window *shrinks* as usage
grows — a tool-heavy day currently fills 1000 events in about four hours. Widening the
fetch is the wrong lever: 2878 events aggregate down to **41 session rows**, so the
grain is the bug, not the limit.

**The page never renders an individual event.** `rows` has exactly four consumers:

| Consumer | Grain actually needed |
|---|---|
| `aggregateSessions` → runs timeline, hero stats, repo list | one row per session |
| repo drill-down, `mergeCounts(repoSessions, …)` | per-session tool/skill counts |
| `latestHookRow`, latest `enabled_plugins` / `always_on_skills` | latest snapshot per user |
| `instructionRows` → CLAUDE.md viewer | latest content row per user, and per repo |

**Shape.** Three public views, following the existing `public_*` conventions (explicit
column whitelist, `REVOKE ALL` then `GRANT SELECT TO anon, authenticated`, and the same
consent gating — see the comment above `public_profile_events`):

- `public_session_summary` — one row per (`user_email`, `session_id`): `repo_name`,
  `started_at`, `ended_at`, `active_ms`, mode segments as `jsonb`, `tool_counts` and
  `skill_counts` as `jsonb`, `agent_calls`. Replaces `aggregateSessions` wholesale.
- `public_user_snapshot` — latest `installed_hooks`, `enabled_plugins`,
  `always_on_skills` per user, from the newest `SessionStart`. Folds in the three
  "latest row that reported one" scans the client does today.
- `public_claude_md_latest` — newest `InstructionsLoaded` content per (user, scope), for
  the global + per-repo viewer.

**Carry over, don't lose:** the mode-segment maths moves into SQL as
`lead(client_ts) over (partition by session_id order by client_ts)`, with the
`IDLE_GAP_MS` (3 min) idle-gap reclassification and same-mode run merging. That heuristic
is currently client-side and marked `ponytail:` as naive with a per-user upgrade path;
in SQL it is harder to tune, so keep it in one named place rather than inlining it.
`skill_name` is null on rows captured before 2026-08-03 — those must still count toward
tool totals but not per-name, exactly as `aggregateSessions` does now.

Once this lands, `public_profile_events` should have no remaining consumer. Drop it
rather than leave a raw-event view exposed.

## 2. Time-windowed views ("last week", not just lifetime)

Wanted regardless of #1, and cheap once session rows exist: filter or group
`public_session_summary` by period so the dashboard can show "last 7 days" alongside
all-time. Do this **after** #1 — windowing raw events would just re-create the
1000-row problem with extra steps.

Until it exists, any figure labelled as a total should say what it actually covers.

## 3. `install.mjs` bare run wipes Supabase credentials

`buildConfig` only writes `supabaseUrl` / `supabasePublishableKey` when passed as
`--url` / `--key`, so a plain `node install.mjs` rewrites
`~/.claude/glasshouse/config.json` **without** them and silently disables the hook's
ability to post. It should merge over the existing config instead of replacing it.
Hit during the always-on-skills work; worked around by passing the current values back in.

## 4. `file_path` is captured with no consent gate

`row.file_path` on `PreToolUse` holds absolute paths into private projects, OS username
included, while every other identifying field (`permission_mode`, `repo_name`,
`enabled_plugins`) is gated at capture time. It does not leak today — the
`public_profile_events` whitelist excludes it — but the protection is one careless view
edit away, and `sanitizeRaw` already deletes `transcript_path` for exactly this reason.
Gate it on activity consent, or reduce it at capture. See `docs/recording_skills.md` §9.

## 5. `public_user_directory` ignores activity consent

It lists any user with a non-null `user_email` from *any* event. `InstructionsLoaded`
rows carry `user_email` gated only on `claudeMd` sharing, so someone who shares their
CLAUDE.md but declines activity sharing still appears with a `run_count`. Already
written up in `docs/recording_skills.md` §3.
