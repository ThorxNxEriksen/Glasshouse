-- Claude Events Analytics Schema
-- Supabase PostgreSQL schema for tracking Claude Code usage via hooks
-- Never executed against any database in this plan

-- Table: claude_events
CREATE TABLE IF NOT EXISTS claude_events (
  id bigint generated always as identity primary key,
  session_id text,
  user_email text,
  hostname text,
  hook_event_name text,
  tool_name text,
  -- Skill invocations are PreToolUse rows with tool_name = 'Skill'; the skill's
  -- own name comes from tool_input.skill. tool_input.args is never captured —
  -- it is free-text user content, unlike the name (a public plugin identifier).
  skill_name text,
  permission_mode text,
  cwd text,
  git_branch text,
  file_path text,
  content text,
  load_reason text,
  installed_hooks jsonb,
  -- The enabled-plugin roster: which capability surfaces are installed. A
  -- *configuration* fact, not usage — a plugin ships many skills and enabling it
  -- says nothing about which ran. Do not read this as "these skills are
  -- uncountable": every skill a plugin ships except its entry point arrives as an
  -- ordinary Skill call and is already counted in skill_name.
  enabled_plugins jsonb,
  -- The one skill per plugin that genuinely cannot be counted: a plugin's own
  -- SessionStart hook prints its entry-point skill as additionalContext, so there
  -- is no Skill tool call, and plugin hooks live in the plugin rather than in
  -- settings.json's "hooks" block so installed_hooks can't see them either.
  -- Shape: [{"plugin":"ponytail@ponytail","skill":"ponytail:ponytail"}, …], a
  -- strict subset of enabled_plugins (3 of 6 on the reference machine). skill is
  -- null when the name can't be inferred safely; the UI falls back to plugin.
  -- Presence only — an entry-point skill loads every session, so counting it
  -- would just be a session count in disguise.
  always_on_skills jsonb,
  -- Gated on consent.activity === "yes", same as permission_mode/enabled_plugins:
  -- null on historical rows (no backfill) and on any row where the repo's
  -- consent isn't activity: "yes". A repo name can itself be sensitive (an
  -- internal or client project name), so it gets the same opt-in treatment as
  -- the rest of activity sharing rather than the ungated cwd/git_branch pattern.
  repo_name text,
  raw jsonb,
  claude_md_share_level text check (claude_md_share_level in ('redacted', 'full')),
  client_ts timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Enable Row Level Security
ALTER TABLE claude_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS claude_events_skill_name_idx
  ON claude_events (skill_name) WHERE skill_name IS NOT NULL;

-- Explicit grants: don't rely on Supabase's implicit default grants to
-- public-schema objects, which Supabase has signaled it may stop doing.
REVOKE ALL ON claude_events FROM anon, authenticated;
GRANT INSERT ON claude_events TO anon;
GRANT SELECT ON claude_events TO authenticated;

-- Policy: anon can only insert
CREATE POLICY "anon_insert_only" ON claude_events
  FOR INSERT TO anon
  WITH CHECK (true);

-- Policy: authenticated can only select
CREATE POLICY "authenticated_select_only" ON claude_events
  FOR SELECT TO authenticated
  USING (true);

-- View 1: claude_md_session - InstructionsLoaded rows
-- security_invoker: views default to running as their creator, which bypasses
-- claude_events' RLS entirely. Without it, the anon key (public/distributed)
-- could read the whole dataset through the view even though the base table
-- restricts anon to INSERT only.
CREATE OR REPLACE VIEW claude_md_session WITH (security_invoker = true) AS
SELECT
  session_id,
  hostname,
  user_email,
  cwd,
  claude_md_share_level,
  content,
  load_reason,
  client_ts
FROM claude_events
WHERE hook_event_name = 'InstructionsLoaded';

REVOKE ALL ON claude_md_session FROM anon;
GRANT SELECT ON claude_md_session TO authenticated;

-- View 2: session_hooks_installed - SessionStart rows with non-null installed_hooks
CREATE OR REPLACE VIEW session_hooks_installed WITH (security_invoker = true) AS
SELECT
  session_id,
  hostname,
  user_email,
  installed_hooks,
  client_ts,
  enabled_plugins
FROM claude_events
WHERE hook_event_name = 'SessionStart'
  AND (installed_hooks IS NOT NULL OR enabled_plugins IS NOT NULL);

REVOKE ALL ON session_hooks_installed FROM anon;
GRANT SELECT ON session_hooks_installed TO authenticated;

-- View 3: permission_mode_summary - duration of permission modes per session
CREATE OR REPLACE VIEW permission_mode_summary WITH (security_invoker = true) AS
WITH windowed AS (
  SELECT
    session_id,
    permission_mode,
    client_ts,
    lead(client_ts) OVER (PARTITION BY session_id ORDER BY client_ts) AS next_ts
  FROM claude_events
)
SELECT
  session_id,
  permission_mode,
  SUM(next_ts - client_ts) AS duration,
  COUNT(*) AS row_count
FROM windowed
WHERE permission_mode IS NOT NULL
  AND next_ts IS NOT NULL
GROUP BY session_id, permission_mode;

REVOKE ALL ON permission_mode_summary FROM anon;
GRANT SELECT ON permission_mode_summary TO authenticated;

-- View 4: session_tool_usage - PreToolUse rows with non-null tool_name
CREATE OR REPLACE VIEW session_tool_usage WITH (security_invoker = true) AS
SELECT
  session_id,
  tool_name,
  COUNT(*) AS uses,
  MIN(client_ts) AS first_used,
  MAX(client_ts) AS last_used
FROM claude_events
WHERE hook_event_name = 'PreToolUse'
  AND tool_name IS NOT NULL
GROUP BY session_id, tool_name;

REVOKE ALL ON session_tool_usage FROM anon;
GRANT SELECT ON session_tool_usage TO authenticated;

-- View 5: session_skill_usage - per-skill invocation counts. Same shape as
-- session_tool_usage, one grain finer: tool_name is always 'Skill' for these
-- rows, so skill_name is what actually distinguishes them.
CREATE OR REPLACE VIEW session_skill_usage WITH (security_invoker = true) AS
SELECT
  session_id,
  skill_name,
  COUNT(*) AS uses,
  MIN(client_ts) AS first_used,
  MAX(client_ts) AS last_used
FROM claude_events
WHERE hook_event_name = 'PreToolUse'
  AND skill_name IS NOT NULL
GROUP BY session_id, skill_name;

REVOKE ALL ON session_skill_usage FROM anon;
GRANT SELECT ON session_skill_usage TO authenticated;

-- Public views (anon-readable). Deliberately NOT security_invoker — claude_events
-- blocks anon at the base-table grant (INSERT only), so a security_invoker view
-- would return zero rows to anon regardless of its own logic. These run with
-- the view owner's privilege instead, and their column lists ARE the security
-- boundary (no RLS backstop) — checked against consent gating and known
-- identifying fields (hostname, cwd, and raw's embedded copy of cwd/file_path).

CREATE OR REPLACE VIEW public_user_directory AS
SELECT user_email, MAX(client_ts) AS last_active, COUNT(DISTINCT session_id) AS run_count
FROM claude_events WHERE user_email IS NOT NULL GROUP BY user_email;
REVOKE ALL ON public_user_directory FROM anon, authenticated;
GRANT SELECT ON public_user_directory TO anon, authenticated;

-- hostname nulled (machine name, never consented). cwd dropped entirely, not
-- just unrendered — it's a full local path, typically with the OS username in
-- it, and a fetch response is a leak even if the UI never prints it. raw is
-- NOT passed through as-is: sanitizeRaw() spreads the whole payload into raw,
-- so every row today also carries a second copy of cwd (verified: 1197/1197
-- rows have raw ? 'cwd').
--
-- This is a WHITELIST, not the denylist it used to be. The prior version
-- subtracted known-bad top-level keys (raw - 'cwd' - 'file_path' - 'path' -
-- 'transcript_path' - 'prompt_id'), which only strips top-level jsonb keys.
-- A live audit found a PreToolUse payload nests a path at
-- tool_input.file_path (kept deliberately by sanitizeRaw's whitelist) plus
-- top-level trigger_file_path/parent_file_path that the denylist never
-- anticipated — a real leak across all 1,746 rows. A denylist rots every
-- time a new field is added upstream; a whitelist can't, because the
-- frontend only ever reads raw?.memory_type, so that's the only key let
-- through here.
CREATE OR REPLACE VIEW public_profile_events AS
SELECT session_id, user_email, NULL::text AS hostname, repo_name, hook_event_name,
       tool_name, skill_name, permission_mode, content, installed_hooks,
       enabled_plugins, always_on_skills,
       jsonb_build_object('memory_type', raw -> 'memory_type') AS raw,
       client_ts
FROM claude_events;
REVOKE ALL ON public_profile_events FROM anon, authenticated;
GRANT SELECT ON public_profile_events TO anon, authenticated;

CREATE OR REPLACE VIEW public_tool_totals AS
SELECT tool_name, COUNT(*) AS call_count FROM claude_events
WHERE hook_event_name = 'PreToolUse' AND tool_name IS NOT NULL GROUP BY tool_name;
REVOKE ALL ON public_tool_totals FROM anon, authenticated;
GRANT SELECT ON public_tool_totals TO anon, authenticated;

CREATE OR REPLACE VIEW public_skill_totals AS
SELECT skill_name, COUNT(*) AS call_count FROM claude_events
WHERE hook_event_name = 'PreToolUse' AND tool_name = 'Skill' AND skill_name IS NOT NULL
GROUP BY skill_name;
REVOKE ALL ON public_skill_totals FROM anon, authenticated;
GRANT SELECT ON public_skill_totals TO anon, authenticated;

-- "Currently enabled" = as of each user's most recent SessionStart with a
-- non-null enabled_plugins (DISTINCT ON per user_email, latest client_ts).
CREATE OR REPLACE VIEW public_plugin_adoption AS
WITH latest_session_start AS (
  SELECT DISTINCT ON (user_email) user_email, enabled_plugins
  FROM claude_events
  WHERE hook_event_name = 'SessionStart' AND enabled_plugins IS NOT NULL AND user_email IS NOT NULL
  ORDER BY user_email, client_ts DESC
)
SELECT plugin.name AS plugin_name, COUNT(DISTINCT user_email) AS user_count
FROM latest_session_start, LATERAL jsonb_array_elements_text(enabled_plugins) AS plugin(name)
GROUP BY plugin.name ORDER BY user_count DESC;
REVOKE ALL ON public_plugin_adoption FROM anon, authenticated;
GRANT SELECT ON public_plugin_adoption TO anon, authenticated;

-- Always-on adoption: which entry-point skills sit in people's context every
-- session. Same "latest SessionStart per user" shape as public_plugin_adoption,
-- but a strict subset of it — only plugins that actually inject. skill_name is
-- null when it could not be inferred, so consumers render skill_name ?? plugin_name.
CREATE OR REPLACE VIEW public_always_on_adoption AS
WITH latest_session_start AS (
  SELECT DISTINCT ON (user_email) user_email, always_on_skills
  FROM claude_events
  WHERE hook_event_name = 'SessionStart' AND always_on_skills IS NOT NULL AND user_email IS NOT NULL
  ORDER BY user_email, client_ts DESC
)
SELECT entry ->> 'plugin' AS plugin_name,
       entry ->> 'skill' AS skill_name,
       COUNT(DISTINCT user_email) AS user_count
FROM latest_session_start, LATERAL jsonb_array_elements(always_on_skills) AS entry
GROUP BY 1, 2 ORDER BY user_count DESC;
REVOKE ALL ON public_always_on_adoption FROM anon, authenticated;
GRANT SELECT ON public_always_on_adoption TO anon, authenticated;

-- public_session_summary: per-session rollup that replaces the client-side
-- aggregateSessions/mergeSegments/activeMs trio in
-- frontend/src/app/profile/[email]/page.tsx. Reproduces two behaviours of
-- that JS that are easy to drop: (a) adjacent same-mode segments are merged
-- (the "islands" trick below), and (b) repo_name is the FIRST non-null value
-- in chronological order, not the min.
CREATE OR REPLACE VIEW public_session_summary AS
WITH ev AS (
  SELECT user_email, session_id, repo_name, permission_mode, hook_event_name,
         tool_name, skill_name, client_ts,
         lead(client_ts) OVER (PARTITION BY session_id ORDER BY client_ts) AS next_ts
  FROM claude_events
  WHERE session_id IS NOT NULL AND user_email IS NOT NULL
),
-- Gaps longer than the idle threshold are the user stepping away, not time
-- spent in that mode. Same rule as IDLE_GAP_MS in the frontend.
seg_raw AS (
  SELECT session_id, client_ts,
         CASE WHEN (extract(epoch FROM (next_ts - client_ts)) * 1000) > 180000
              THEN 'waiting' ELSE permission_mode END AS mode,
         (extract(epoch FROM (next_ts - client_ts)) * 1000)::bigint AS ms
  FROM ev
  WHERE permission_mode IS NOT NULL AND next_ts IS NOT NULL
),
-- Islands trick: row_number() over the partition minus row_number() over the
-- partition-plus-mode is constant across a run of consecutive same-mode rows
-- and changes whenever the mode changes, so grouping by it merges adjacent
-- same-mode segments (mirrors the client's mergeSegments).
islands AS (
  SELECT *,
         row_number() OVER (PARTITION BY session_id ORDER BY client_ts)
       - row_number() OVER (PARTITION BY session_id, mode ORDER BY client_ts) AS grp
  FROM seg_raw
),
merged AS (
  SELECT session_id, mode, sum(ms) AS ms, min(client_ts) AS seg_start
  FROM islands GROUP BY session_id, mode, grp
),
seg AS (
  SELECT session_id,
         jsonb_agg(jsonb_build_object('mode', mode, 'ms', ms) ORDER BY seg_start) AS segments,
         coalesce(sum(ms) FILTER (WHERE mode <> 'waiting'), 0)::bigint AS active_ms
  FROM merged GROUP BY session_id
),
tools AS (
  SELECT session_id,
         jsonb_object_agg(tool_name, n) AS tool_counts,
         coalesce(sum(n) FILTER (WHERE tool_name = 'Agent'), 0)::bigint AS agent_calls
  FROM (SELECT session_id, tool_name, count(*) AS n FROM claude_events
        WHERE hook_event_name = 'PreToolUse' AND tool_name IS NOT NULL
        GROUP BY session_id, tool_name) t
  GROUP BY session_id
),
-- skill_name is null on rows captured before 2026-08-03; those still count in
-- tool_counts as 'Skill' but cannot be counted per name.
skills AS (
  SELECT session_id, jsonb_object_agg(skill_name, n) AS skill_counts
  FROM (SELECT session_id, skill_name, count(*) AS n FROM claude_events
        WHERE hook_event_name = 'PreToolUse' AND skill_name IS NOT NULL
        GROUP BY session_id, skill_name) s
  GROUP BY session_id
),
base AS (
  SELECT user_email, session_id,
         (array_agg(repo_name ORDER BY client_ts) FILTER (WHERE repo_name IS NOT NULL))[1] AS repo_name,
         min(client_ts) AS started_at, max(client_ts) AS ended_at
  FROM ev GROUP BY user_email, session_id
)
SELECT b.user_email, b.session_id, b.repo_name, b.started_at, b.ended_at,
       coalesce(seg.active_ms, 0) AS active_ms,
       (extract(epoch FROM (b.ended_at - b.started_at)) * 1000)::bigint AS wallclock_ms,
       coalesce(seg.segments, '[]'::jsonb) AS segments,
       coalesce(tools.tool_counts, '{}'::jsonb) AS tool_counts,
       coalesce(skills.skill_counts, '{}'::jsonb) AS skill_counts,
       coalesce(tools.agent_calls, 0) AS agent_calls
FROM base b
LEFT JOIN seg ON seg.session_id = b.session_id
LEFT JOIN tools ON tools.session_id = b.session_id
LEFT JOIN skills ON skills.session_id = b.session_id;
REVOKE ALL ON public_session_summary FROM anon, authenticated;
GRANT SELECT ON public_session_summary TO anon, authenticated;

-- Per-user rollups built on public_session_summary, not claude_events, so the
-- idle-time rule stays defined in exactly one place.
--
-- session_count and repo_day_run_count are deliberately different numbers:
-- session_count counts sessions (public_session_summary rows), while
-- repo_day_run_count counts distinct (repo, UTC day) pairs -- the frontend
-- confusingly calls both "runs" (heroRuns vs repoList[].runs); this view
-- keeps the names distinct instead of collapsing them.
CREATE OR REPLACE VIEW public_user_totals AS
WITH per_name AS (
  SELECT user_email, key AS name, sum(value::bigint) AS n, 'tool' AS kind
  FROM public_session_summary, jsonb_each_text(tool_counts) GROUP BY 1, 2
  UNION ALL
  SELECT user_email, key AS name, sum(value::bigint) AS n, 'skill' AS kind
  FROM public_session_summary, jsonb_each_text(skill_counts) GROUP BY 1, 2
)
SELECT s.user_email,
       count(*) AS session_count,
       -- Matches the frontend's UTC dayKey(); a local-time cast would differ.
       count(DISTINCT (coalesce(s.repo_name, '(unknown repo)'),
                       (s.started_at AT TIME ZONE 'UTC')::date)) AS repo_day_run_count,
       count(DISTINCT coalesce(s.repo_name, '(unknown repo)')) AS repo_count,
       coalesce(sum(s.active_ms), 0)::bigint AS active_ms,
       coalesce((SELECT jsonb_object_agg(name, n) FROM per_name p
                 WHERE p.user_email = s.user_email AND p.kind = 'tool'), '{}'::jsonb) AS tool_counts,
       coalesce((SELECT jsonb_object_agg(name, n) FROM per_name p
                 WHERE p.user_email = s.user_email AND p.kind = 'skill'), '{}'::jsonb) AS skill_counts,
       min(s.started_at) AS first_seen,
       max(s.ended_at) AS last_seen
FROM public_session_summary s
GROUP BY s.user_email;
REVOKE ALL ON public_user_totals FROM anon, authenticated;
GRANT SELECT ON public_user_totals TO anon, authenticated;

-- Per-user configuration snapshot. The three fields come from three
-- independently-chosen rows: installed_hooks from the newest SessionStart
-- that has one, enabled_plugins/always_on_skills each from the newest row
-- with a NON-EMPTY array -- which may be a different row from the other two.
-- A single DISTINCT ON over all three columns would silently force them to
-- come from one row, so this stays three correlated subqueries.
CREATE OR REPLACE VIEW public_user_snapshot AS
WITH emails AS (
  SELECT DISTINCT user_email FROM claude_events WHERE user_email IS NOT NULL
)
SELECT e.user_email,
       (SELECT installed_hooks FROM claude_events c
        WHERE c.user_email = e.user_email AND c.hook_event_name = 'SessionStart'
          AND c.installed_hooks IS NOT NULL
        ORDER BY c.client_ts DESC LIMIT 1) AS installed_hooks,
       (SELECT enabled_plugins FROM claude_events c
        WHERE c.user_email = e.user_email
          AND jsonb_array_length(coalesce(c.enabled_plugins, '[]'::jsonb)) > 0
        ORDER BY c.client_ts DESC LIMIT 1) AS enabled_plugins,
       (SELECT always_on_skills FROM claude_events c
        WHERE c.user_email = e.user_email
          AND jsonb_array_length(coalesce(c.always_on_skills, '[]'::jsonb)) > 0
        ORDER BY c.client_ts DESC LIMIT 1) AS always_on_skills
FROM emails e;
REVOKE ALL ON public_user_snapshot FROM anon, authenticated;
GRANT SELECT ON public_user_snapshot TO anon, authenticated;

-- Newest CLAUDE.md per (user, memory_type, repo). memory_type comes out of raw
-- as a plain column so raw itself never reaches a public view.
CREATE OR REPLACE VIEW public_claude_md_latest AS
SELECT DISTINCT ON (user_email, coalesce(raw->>'memory_type', 'Project'), coalesce(repo_name, '(unknown repo)'))
       user_email,
       coalesce(raw->>'memory_type', 'Project') AS memory_type,
       repo_name, content, client_ts
FROM claude_events
WHERE hook_event_name = 'InstructionsLoaded' AND content IS NOT NULL AND user_email IS NOT NULL
ORDER BY user_email, coalesce(raw->>'memory_type', 'Project'),
         coalesce(repo_name, '(unknown repo)'), client_ts DESC;
REVOKE ALL ON public_claude_md_latest FROM anon, authenticated;
GRANT SELECT ON public_claude_md_latest TO anon, authenticated;
