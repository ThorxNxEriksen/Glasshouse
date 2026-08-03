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
