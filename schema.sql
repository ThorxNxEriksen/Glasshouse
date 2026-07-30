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
  permission_mode text,
  cwd text,
  git_branch text,
  file_path text,
  content text,
  load_reason text,
  installed_hooks jsonb,
  raw jsonb,
  claude_md_share_level text check (claude_md_share_level in ('redacted', 'full')),
  client_ts timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Enable Row Level Security
ALTER TABLE claude_events ENABLE ROW LEVEL SECURITY;

-- Policy: anon can only insert
CREATE POLICY "anon_insert_only" ON claude_events
  FOR INSERT TO anon
  WITH CHECK (true);

-- Policy: authenticated can only select
CREATE POLICY "authenticated_select_only" ON claude_events
  FOR SELECT TO authenticated
  USING (true);

-- View 1: claude_md_session - InstructionsLoaded rows
CREATE OR REPLACE VIEW claude_md_session AS
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

GRANT SELECT ON claude_md_session TO authenticated;

-- View 2: session_hooks_installed - SessionStart rows with non-null installed_hooks
CREATE OR REPLACE VIEW session_hooks_installed AS
SELECT
  session_id,
  hostname,
  user_email,
  installed_hooks,
  client_ts
FROM claude_events
WHERE hook_event_name = 'SessionStart'
  AND installed_hooks IS NOT NULL;

GRANT SELECT ON session_hooks_installed TO authenticated;

-- View 3: permission_mode_summary - duration of permission modes per session
CREATE OR REPLACE VIEW permission_mode_summary AS
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

GRANT SELECT ON permission_mode_summary TO authenticated;

-- View 4: session_tool_usage - PreToolUse rows with non-null tool_name
CREATE OR REPLACE VIEW session_tool_usage AS
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

GRANT SELECT ON session_tool_usage TO authenticated;
