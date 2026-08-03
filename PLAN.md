# Glasshouse — public Claude Code usage analytics (Supabase + Vercel)

## Context

Thor wants to see how he and colleagues actually work with Claude Code — CLAUDE.md content, hooks installed, skills invoked, MCP servers/tools used, and time spent per permission mode (plan/auto/manual/etc.) — as a shared, browsable dataset. Unlike the original framing, this is now explicitly meant to be **public from the start**, not an internal-only tool: open sign-up, Supabase Auth required to read, no raw database access handed to anyone, and per-repo, per-share-type consent captured **before** any data ever leaves a machine, since the data can include proprietary/client content from any repo a contributor works in.

Project name: **Glasshouse**. New standalone repo at `C:\dev\glasshouse` (sibling to `internal-market-intelligence`, unrelated to it). The dashboard frontend Thor is designing (handed off from a Claude Code design session) lives inside this same repo and deploys to Vercel.

This supersedes a pending idea from two days ago (`project_skill_usage_analytics` memory: a narrower "log Skill tool calls to a local file" hook, proposed but never built) and an earlier, now-revised version of this same plan that assumed internal-only sharing with no redaction and Vercel-deployment-protection instead of real auth.

## Verified facts driving the design

**Claude Code hooks** (`code.claude.com/docs/en/hooks`):
- `InstructionsLoaded` is the documented event for reconstructing effective CLAUDE.md (fires per file: `file_path`, `content`, `load_reason`).
- Skills and MCP tools have no dedicated events — they appear as ordinary `PreToolUse`/`PostToolUse`. **MCP tools** put the identity in `tool_name` (`mcp__<server>__<tool>`). **Skills do not**: `tool_name` is the literal string `"Skill"` for every skill, and the skill's own name is in `tool_input.skill` (with free-text `tool_input.args` alongside it, which must never be captured). An earlier version of this line claimed `tool_name` was the skill name; that was wrong, and it is why the first implementation of `sanitizeRaw` narrowed `tool_input` to `file_path` alone and silently discarded every skill name. Verified 2026-08-03 against real transcripts and a live round-trip into `claude_events.skill_name`.
- **Always-on skills are not visible as tool calls at all.** Plugins like `superpowers` and `ponytail` inject their skill text via a `SessionStart` hook, so no `Skill` tool call is ever made. Plugin hooks are also declared in the plugin's own manifest, not in `~/.claude/settings.json`, so `installed_hooks` cannot see them either. `enabledPlugins` from `settings.json` is the only local signal — hence the `enabled_plugins` column. It records presence, not usage, which is the honest measurement for a skill that loads unconditionally every session.
- No "permission mode changed" event — every qualifying hook payload carries the current `permission_mode`; time-in-mode is reconstructed downstream via SQL `lag()`/`lead()` over timestamped rows.
- **Confirmed directly from this session's own transcript**: a `SessionStart` hook can exit 0 and print `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}` — Claude Code wraps that string as a system-reminder inserted into the conversation, which Claude reads on its next turn and can act on. This is exactly the mechanism the `superpowers` plugin uses to auto-inject `using-superpowers` every session (seen live at the top of this conversation) — proven to work in this exact environment. **This is the mechanism Glasshouse uses to ask per-repo consent**, instead of building any custom interactive-prompt system.
- Exit-code protocol confirmed: exit 0 + JSON on stdout = context injection (no blocking); exit 2 = blocking with stderr shown to Claude; any other nonzero = non-blocking error, logged only.

**Supabase** (verified via context7 against current docs, checked 2026-07-30):
- Legacy `anon`/`service_role` keys are being replaced by `sb_publishable_...` / `sb_secret_...` keys; legacy fully deprecated by end of 2026. Same underlying Postgres roles (`anon`, `authenticated`, `service_role`) — only the key format and client env var names change. Build on the new keys from day one.
- "The publishable key is safe to use on the frontend... Service role and secret keys must never be exposed on the frontend" — Glasshouse only ever distributes/embeds the **publishable key**; the secret key stays with Thor for schema/admin only.
- Magic-link auth is `supabase.auth.signInWithOtp({ email })` — no OAuth app registration needed, open sign-up by default (`shouldCreateUser` defaults to true).
- RLS scoped `to authenticated` is the standard way to require login while keeping sign-up itself open to anyone.

## Design

### Two independent gates: consent (what leaves a machine) vs. auth (who can view it)
1. **Consent** — controls whether/what Glasshouse ever sends from a given repo, decided once per repo, asked in-conversation via Claude itself.
2. **Auth** — controls who can view the public dashboard once data exists in Supabase. Sign-up is open to anyone (matches "public from the start"); nobody gets raw DB credentials — not even Thor uses direct Studio queries as part of the normal flow, everything goes through the authenticated app.

These are deliberately separate: a repo owner's consent decision is what actually protects sensitive content (never transmitted at all if declined); auth just gates the read surface for whatever *was* consented and sent.

### Repo layout
```
glasshouse/
├── hooks/glasshouse.mjs   # single script: hook dispatcher (stdin) + consent CLI (argv)
├── install.mjs            # one-shot installer, run once per contributor's machine
├── schema.sql             # run once by Thor against the new Supabase project
├── frontend/              # Next.js app, Supabase Auth (magic link), deployed to Vercel
└── README.md
```

### 1. Per-repo consent flow (the new core piece)
- Consent store: `~/.claude/glasshouse/consent.json`, keyed by a **repo identity** — `git remote get-url origin` (trimmed of `.git`) when available, else the absolute repo path.
- `SessionStart` hook: compute the repo key for `cwd`; if no entry exists in the consent store, exit 0 with `additionalContext` instructing Claude to:
  1. Ask the user via `AskUserQuestion` — exactly two axes, kept minimal on purpose:
     - **CLAUDE.md sharing**: `none` / `redacted` (default, recommended) / `full`.
     - **Activity sharing** (tool/skill/MCP usage + permission-mode timing): `yes` / `no`.
  2. Run `node <hookPath> consent --repo "<repoKey>" --claude-md <none|redacted|full> --activity <yes|no>` to record the answer.
  3. Until that command runs, Glasshouse sends nothing at all for this repo (not even a "declined" marker beyond the local consent file).
- All other hook firings (`InstructionsLoaded`, `PreToolUse`, `SessionEnd`) look up the same repo key before sending anything:
  - No consent record at all → no-op, silently (SessionStart already asked; don't nag every event).
  - `activity = no` → skip all `PreToolUse`/`SessionEnd` rows.
  - `claudeMd = none` → skip `InstructionsLoaded` entirely.
  - `claudeMd = redacted` → strip the `content` field down to markdown heading lines only (`^#+ ...`) plus a line/char count note (e.g. `"[glasshouse: body redacted — 42 lines / 3110 chars omitted]"`) before sending. This is a structural summary, not PII-grade scrubbing — flagged as a known ceiling; a smarter redactor (strip secrets/proper nouns) is a documented upgrade path if headings-only proves too thin or too revealing.
  - `claudeMd = full` → send raw content as-is.
- Re-running consent later (to change a decision) is just re-running the same `consent` subcommand — no separate "update" path needed.

### 2. `hooks/glasshouse.mjs`
One script, dispatches by invocation shape:
- **No argv** → hook mode: read stdin JSON once, look up consent for the computed repo key, build a row per the rules above, POST to `${supabaseUrl}/rest/v1/claude_events` using the **publishable key**, 1.2s abort timeout, wrapped so no exception ever propagates and the process always exits 0 (a failed POST must never interrupt a real session).
- **`consent` argv subcommand** → read/merge/write `~/.claude/glasshouse/consent.json`.
Zero npm dependencies (Node's global `fetch`/`AbortController` suffice), same shebang/stdin-parsing idiom as the existing `~/.claude/hooks/block-destructive-git.mjs`.

### 3. Config
`~/.claude/glasshouse/config.json` (written by `install.mjs`, never committed anywhere): `{ supabaseUrl, supabasePublishableKey, userEmail }`. `userEmail` falls back to `git config --global user.email` if unset. Separate from `consent.json` in the same directory.

### 4. `install.mjs`
`node install.mjs --url <url> --key <publishable-key> --email <you>`: writes the config file, copies `glasshouse.mjs` to `~/.claude/hooks/`, and **merges** (idempotent, additive) the hooks block into `~/.claude/settings.json` — adding `SessionStart`, `InstructionsLoaded`, a sibling `"*"`-matcher `PreToolUse` block, and `SessionEnd`, all pointing at `glasshouse.mjs`. Verified against Thor's actual current `~/.claude/settings.json`: today it has exactly one `PreToolUse` entry (`Bash|PowerShell` → `block-destructive-git.mjs`) and no other hook events — the installer must leave that entry untouched and add the `"*"` matcher as a sibling in the same array, not replace it.

### 5. Supabase schema (`schema.sql`)
Same single append-only `claude_events` table as before (`session_id`, `user_email`, `hostname`, `hook_event_name`, `tool_name`, `permission_mode`, `cwd`, `git_branch`, `file_path`/`content`/`load_reason`, `installed_hooks` jsonb, `raw` jsonb, `client_ts`), plus one addition: `claude_md_share_level text` (`redacted`/`full`, null otherwise) so the frontend can badge redacted content honestly.

RLS, reflecting the two-gate model:
- `for insert to anon with check (true)` — the write path. This is intentionally still the publishable/`anon` key: contributors' machines need to insert without a login flow embedded in a background hook, and insert-only grants zero read/query ability — it is not "direct access" to the data, just a one-way funnel.
- `for select to authenticated using (true)` — reads require a signed-in Supabase Auth user (any signed-up user, since sign-up itself is open); no `anon`-role select policy at all. No update/delete for anyone — rows are immutable.
- Same four SQL views as before (`claude_md_session`, `session_hooks_installed`, `permission_mode_summary`, `session_tool_usage`), with `GRANT SELECT ... TO authenticated` (not `anon`).

### 6. Frontend (`frontend/`, Vercel-deployed)
- Next.js app; Supabase Auth via `signInWithOtp` (magic link) — open sign-up, no OAuth app registration required, matches "public from the start."
- Client env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Vercel project env vars, never committed). No secret key anywhere in the frontend.
- No Vercel deployment protection needed — the login screen itself is the access gate now, consistent with a public URL.
- UI reads the four views directly; the design/build of this UI is Thor's separate design-handoff work — this plan only guarantees Supabase is shaped and reachable for it.

### 7. README (contributor-facing, 3 steps)
Download → run `install.mjs` with the URL/key Thor gives out → use Claude Code normally. First time in any given repo, Claude will ask what to share from it before anything is sent.

## Critical files
- `C:\dev\glasshouse\hooks\glasshouse.mjs` (new)
- `C:\dev\glasshouse\install.mjs` (new)
- `C:\dev\glasshouse\schema.sql` (new)
- `C:\dev\glasshouse\frontend\` (new — scaffold only; UI build is Thor's separate design-handoff work)
- `C:\dev\glasshouse\README.md` (new)
- `C:\Users\ThorNoergaardEriksen\.claude\settings.json` (existing — merge target; keep `enabledPlugins`, `statusLine`, `permissions.defaultMode: "auto"`, and the existing `PreToolUse` entry untouched)
- `C:\Users\ThorNoergaardEriksen\.claude\hooks\block-destructive-git.mjs` (existing — reference idiom only, must keep firing unmodified)

## Verification
1. Create the Supabase project (new, "glasshouse", Thor's org); confirm new-format keys are issued (enable `publishable`/`secret` types if it defaults to legacy-only); apply `schema.sql` including both RLS policies and view grants.
2. Enable email/magic-link auth in the Supabase Auth settings (open sign-up).
3. Run `install.mjs` locally for Thor first, pointed at a throwaway/test repo.
4. Start a session in that repo: confirm the consent prompt actually appears (via the `additionalContext` mechanism) and answering it writes `~/.claude/glasshouse/consent.json` correctly.
5. Run a full session exercising every path: read a file, run a Bash command, invoke a skill, flip into plan mode and back, exit — confirm rows land in `claude_events` only for repos with consent, and that `claude-md` content is genuinely headings-only when `redacted` was chosen.
6. Query the four views directly — `claude_md_session`, `session_hooks_installed`, `permission_mode_summary`, `session_tool_usage` — confirm they read sensibly for the test session.
7. Confirm the **`anon`** key cannot `SELECT` from `claude_events` or the views (should get a permission-denied/empty result) — proves the "no direct access without auth" boundary actually holds.
8. Sign up via magic link in a local frontend dev run and confirm an authenticated session *can* read the views.
9. Only then hand `README.md` + `install.mjs` + `hooks/glasshouse.mjs` + the URL/publishable key to colleagues (never the secret key).

## Explicitly out of scope for this plan (flag if wanted sooner)
- Building the actual frontend UI — Thor's separate Claude-Code design-handoff track; this plan only scaffolds `frontend/` and guarantees the Supabase side is ready.
- Per-user/per-row visibility settings beyond the repo-level consent decision (e.g., letting a contributor hide just their own sessions after the fact) — the consent flow already prevents anything unwanted from being sent in the first place; finer-grained *retroactive* privacy controls are a later addition if requested.
- Smarter CLAUDE.md redaction (secret/PII-pattern scrubbing beyond headings-only) — flagged as a known ceiling above; upgrade only if headings-only proves insufficient.
- No OTel Collector — hooks POST straight to PostgREST; OTel remains a documented alternative only if hook-based mode-diffing proves too coarse.
- No local buffering/retry queue for offline hook POSTs — a missed row is just a missed row.
