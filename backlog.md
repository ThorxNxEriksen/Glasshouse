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

**Two grains, and they are not interchangeable.** Session rows drive the runs timeline;
the overall per-user numbers (hero stats, skills / MCP / tools cards) are user-grain and
should be rolled up as such rather than summed in the browser from session rows. This is
the same split the home page already gets right with `public_tool_totals` /
`public_skill_totals` / `public_plugin_adoption` — the profile page is the one still
doing it client-side from raw events.

**Shape.** Four public views, following the existing `public_*` conventions (explicit
column whitelist, `REVOKE ALL` then `GRANT SELECT TO anon, authenticated`, and the same
consent gating — see the comment above `public_profile_events`):

- `public_user_totals` — one row per user: `tool_counts` / `skill_counts` as `jsonb`,
  `session_count`, `active_ms`, `repo_count`, `first_seen`, `last_seen`. Drives the hero
  stats and the skills / MCP / tools cards, at their real grain.
- `public_session_summary` — one row per (`user_email`, `session_id`): `repo_name`,
  `started_at`, `ended_at`, `active_ms`, mode segments as `jsonb`, `agent_calls`, plus
  per-session `tool_counts` / `skill_counts`. Drives the runs timeline; carrying the
  counts here lets the repo drill-down re-aggregate by repo without a fifth view.
- `public_user_snapshot` — latest `installed_hooks`, `enabled_plugins`,
  `always_on_skills` per user, from the newest `SessionStart`. Folds in the three
  "latest row that reported one" scans the client does today.
- `public_claude_md_latest` — newest `InstructionsLoaded` content per (user, scope), for
  the global + per-repo viewer.

MCP counts are derived from `tool_name` prefixes, not stored — keep that derivation in
one place if it moves server-side, and see item 5 first.

**Carry over, don't lose:** the mode-segment maths moves into SQL as
`lead(client_ts) over (partition by session_id order by client_ts)`, with the
`IDLE_GAP_MS` (3 min) idle-gap reclassification and same-mode run merging. That heuristic
is currently client-side and marked `ponytail:` as naive with a per-user upgrade path;
in SQL it is harder to tune, so keep it in one named place rather than inlining it.
`skill_name` is null on rows captured before 2026-08-03 — those must still count toward
tool totals but not per-name, exactly as `aggregateSessions` does now.

Once this lands, `public_profile_events` should have no remaining consumer. Drop it
rather than leave a raw-event view exposed.

## 2. Time-windowed views ("last week", not just lifetime) — deferred

**Explicitly not wanted yet** (decided 2026-08-04); lifetime figures are enough for now.
Recorded because it is the obvious next ask once #1 lands, and cheap at that point:
filter or group `public_session_summary` by period to show "last 7 days" alongside
all-time. Do it **after** #1 — windowing raw events would just re-create the 1000-row
problem with extra steps.

Until then, any figure labelled as a total should say what it actually covers.

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

## 5. Two MCP servers render as near-identical labels

`parseMcpServer` (`frontend/lib/mcp.ts`) strips the `claude_ai_` prefix, so the
claude.ai-hosted server and a local one of the same name collapse to labels differing
only by case — the MCP card shows `Supabase` (131 calls) beside `supabase` (25), and
`Vercel` (21) beside `vercel` (9). They are genuinely different servers, so this is not
double-counting, but a viewer can't tell that and it reads as a bug. Either distinguish
them (`Supabase (claude.ai)` vs `supabase (local)`) or merge them deliberately; the
current middle ground is the only wrong answer.

## 6. `public_user_directory` ignores activity consent

It lists any user with a non-null `user_email` from *any* event. `InstructionsLoaded`
rows carry `user_email` gated only on `claudeMd` sharing, so someone who shares their
CLAUDE.md but declines activity sharing still appears with a `run_count`. Already
written up in `docs/recording_skills.md` §3.

---

Items 7–12 are carried over from `PLAN.md` (removed 2026-08-04 — every design
section in it was built, and its auth model contradicted the public dashboard;
see git history). Longer horizon than the above, not newer.

## 7. Authentication — planned

Intended, not merely deferred. Scope undecided; **the constraint is that auth is
additive.** It must not become a reason to gate the public views — `CLAUDE.md` is
explicit that no login between visitor and dashboard is the product.

Already in the tree and **not dead code — do not clean it up**: the
`authenticated`-granted views in `schema.sql` (`claude_md_session`,
`permission_mode_summary`, `session_tool_usage`, `session_skill_usage`,
`session_hooks_installed`), read by nothing today; plus `sendMagicLink` in
`frontend/lib/supabaseClient.ts` and `frontend/lib/useSupabaseSession.ts`, both
unreferenced by any page. The `emailRedirectTo` comment there records an
already-debugged bug.

Decide *what sign-in is for* before building the flow — the mechanism is solved.
Candidates: owner-only view of your own data, a consent-management UI, and #8.

## 8. Per-user retroactive visibility controls

Withdrawing your own already-sent rows, beyond the per-repo consent decision made
before anything is sent. Deferred because consent already stops unwanted data at
the source; more plausible now that profiles are publicly browsable by email.
Largely blocked on #7 — withdrawing your rows requires proving which are yours.

## 9. Smarter CLAUDE.md redaction

`redacted` is headings-only plus a line/char count: a structural summary, not
PII-grade scrubbing. Known ceiling, accepted deliberately. Upgrade to
secret/pattern scrubbing only if headings-only proves too thin or too revealing.

## 10. Local buffering / retry queue for hook POSTs

Hook POSTs go straight to PostgREST with a short abort timeout; offline or failed
sends are dropped. Deferred because a failed POST must never interrupt a session
and a retry queue is more machinery than the data is worth. Revisit only if gaps
visibly distort the dashboard.

## 11. OTel Collector

Not used; hooks POST directly to PostgREST. A documented alternative only if
hook-based permission-mode diffing proves too coarse.

## 12. Per-session work-type classification

Bucket sessions as build / debug / refactor / analyse / plan / prototype / docs —
taxonomy borrowed from Claude Code's built-in `/team-onboarding`.

**Don't copy its method.** That command classifies from each session's *first user
message*; free-text prompts are exactly what `sanitizeRaw` refuses to transmit, and
a label inferred from text we never published is covered by no consent category.
The version that fits is a view over the `tool_name` sequence already stored —
Edit/Write-heavy → build, Read/Grep with no writes → plan, repeated Read→Edit on
one file → debug. Weak proxy: it will misread sessions that plan first, build
second. Drop the idea if the buckets read as noise.

## 13. "Pull from target before opening a PR" — enforce via hook, not memory

`CLAUDE.md` states the rule (global instructions: "Pull from the target branch
before creating PRs") but nothing checks it — it only holds as long as the agent
remembers to read it. A `PreToolUse` hook gating `gh pr create` (or a git
pre-push check comparing local `HEAD` against `origin/<base>`) would catch a
stale branch mechanically instead of relying on instruction-following. Not
started; raised as a question, not a decision — worth weighing against the
false-positive cost of blocking a legitimate PR command.
