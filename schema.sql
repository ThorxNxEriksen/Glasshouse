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
  -- Always-on skills (superpowers, ponytail) are injected by *plugin*
  -- SessionStart hooks: they never appear in settings.json's "hooks" block and
  -- produce no Skill tool call, so enabledPlugins is the only signal they ran.
  enabled_plugins jsonb,
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
       enabled_plugins,
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
