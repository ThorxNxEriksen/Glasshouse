# Project-Scoped Supabase MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single user-scoped Supabase MCP server — currently pinned to the wrong project in every repo — with per-repo `.mcp.json` entries, so an agent working in a repo can only reach that repo's own Supabase project.

**Architecture:** Delete the user-scoped `supabase` entry from `~/.claude.json`. Add a project-scoped `.mcp.json` to each repo that owns a Supabase project, each with its own `project_ref`. Supabase's hosted MCP treats `project_ref` as a hard scope — it disables account-level tools entirely — so a mis-targeted migration becomes impossible rather than merely unlikely.

**Tech Stack:** Claude Code MCP config (`~/.claude.json`, `.mcp.json`), Supabase hosted MCP (`https://mcp.supabase.com/mcp`), OAuth dynamic client registration.

## Global Constraints

- **Project refs (verified 2026-08-06 via `list_projects`, org `idjybbrfxklsnqnydiwb`):**
  - `smzccpjmakavoxlsrvku` — **Glasshouse**, region `eu-north-1`. Confirmed in `frontend/.env.local` and hardcoded at `glasshouse-plugin/glasshouse.mjs:26`.
  - `djftqoqbdlrhsgsfpstv` — **clotta-meal-tracker**, region `eu-west-2`. Confirmed in `C:/dev/meal-tracker-top/meal-tracker/.env.local`.
- **Server URL form:** `https://mcp.supabase.com/mcp?project_ref=<ref>`. Per Supabase docs the hosted server accepts exactly three query params — `project_ref`, `read_only`, `features`. Do **not** add `read_only=true`: backlog item #1 requires `apply_migration` against Glasshouse.
- **OAuth grants are keyed by the full server URL including query string.** Changing or adding a `project_ref` invalidates any existing grant for that entry — re-authentication after every URL change is expected, not a failure.
- **`~/.claude.json` is rewritten by every running Claude Code session on exit.** Any hand-edit can be silently clobbered. Use the `claude mcp` CLI, and prefer having no other sessions open during Task 1.
- **There are three config profiles, and only one is authoritative.** `CLAUDE_CONFIG_DIR` selects between them:

  | Profile | Config file | Authoritative for `mcpServers`? |
  |---|---|---|
  | default | `C:/Users/ThorNoergaardEriksen/.claude.json` | **yes** |
  | claude-work | `C:/Users/ThorNoergaardEriksen/.claude-work/.claude.json` | no — overwritten on launch |
  | claude-personal | `C:/Users/ThorNoergaardEriksen/.claude-personal/.claude.json` | no — overwritten on launch |

  Per the user's global CLAUDE.md, `claude-work` and `claude-personal` copy MCP server config in from the default account **on every launch** (real symlinks are blocked by device policy). A `claude mcp remove` run inside a work/personal session therefore reverts itself at next start. **Every `mcpServers` change in this plan must land in the default profile**, and the two derived profiles should be cleaned too so the state is consistent until the next launch resyncs them.

  **Mechanism, read from source** — `Sync-ClaudeMcpServers` in `~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1`, called by `Sync-ClaudeProfile` from the `claude-work` / `claude-personal` shell functions:

  ```powershell
  $canonicalPath = "$env:USERPROFILE\.claude.json"   # the default profile's config
  # ...then, in node:
  target.mcpServers = canonical.mcpServers || {};    # wholesale replace, not a merge
  ```

  Two consequences, both load-bearing for this plan:

  - **Removing from the default profile is sufficient and durable.** The key is replaced wholesale at every launch, so a stale `supabase` cannot survive in a derived profile once the default is clean. Cleaning the derived profiles too is belt-and-braces for the *current* session only.
  - **Trust state is preserved.** The script reads the existing target file and replaces only `mcpServers` before writing back, so `projects` — including the `enabledMcpjsonServers` approvals Tasks 2 and 3 create — is untouched. Project-scoped `.mcp.json` servers are a different mechanism entirely and are unaffected by this sync.

  Related: a `PreToolUse` hook at `~/.claude/hooks/profile-config.mjs` blocks Write/Edit against `CLAUDE.md`, `settings.json`, and `commands/` inside a profile directory, redirecting to `~/.claude`. It deliberately does **not** cover `.claude.json` — that file is handled by the launcher merge above, which is why a `claude mcp remove` in a profile session fails silently rather than being blocked.
- **Do not touch** the per-project `disabledMcpServers: ['drawio']` entries under `C:/dev/glasshouse` and `C:/dev/internal-market-intelligence`. Unrelated, and dropping them re-enables a server that fails to connect.
- **`claude.ai Supabase` must stay disabled.** It is unscoped (`https://mcp.supabase.com/mcp`, no ref). Re-enabling it restores exactly the account-wide access this plan removes, and re-creates the duplicate that Glasshouse's own `backlog.md` #5 describes.

---

## File Structure

| File | Responsibility |
|---|---|
| `~/.claude.json` → `mcpServers.supabase` | **Deleted.** Was the single global pin causing wrong-project reach. |
| `C:/dev/glasshouse/.mcp.json` | Create. Scopes Supabase to `smzccpjmakavoxlsrvku` for this repo only. Tracked by git (repo has no root `.gitignore`). |
| `C:/dev/meal-tracker-top/meal-tracker/.mcp.json` | Create. Scopes Supabase to `djftqoqbdlrhsgsfpstv`. |
| `C:/dev/glasshouse/CLAUDE.md` | Modify. Record which project this repo may touch and why the scope exists. |
| `C:/dev/meal-tracker-top/meal-tracker/CLAUDE.md` | Modify. Same, for that repo. |

**Note on committing the ref:** a Supabase project ref is not a secret — it is in the URL of every browser call any deployed Supabase app makes, and security rests on the anon key plus RLS. Glasshouse's ref is already committed at `glasshouse-plugin/glasshouse.mjs:26`, so `.mcp.json` exposes nothing new.

**Worktree:** Tasks 2 and 4 modify tracked files in Glasshouse. Per the global CLAUDE.md convention, run them in a worktree (`EnterWorktree`) rather than on the current branch. Tasks 1 and 3 touch files outside the Glasshouse repo and are worktree-independent.

---

## Task 1: Remove the global user-scoped Supabase server

**Files:**
- Modify: `C:/Users/ThorNoergaardEriksen/.claude.json` (**default profile — the authoritative one**)
- Modify: `C:/Users/ThorNoergaardEriksen/.claude-work/.claude.json`
- Modify: `C:/Users/ThorNoergaardEriksen/.claude-personal/.claude.json`

All three via the `claude mcp` CLI with `CLAUDE_CONFIG_DIR` set appropriately — do not hand-edit. See the profile table in Global Constraints: removing from only the profile you happen to be running in is undone at next launch.

**Interfaces:**
- Consumes: nothing.
- Produces: an environment where the name `supabase` resolves to no server, so Tasks 2 and 3 can bind it per-project without collision.

- [ ] **Step 1: Record the current state so the change is verifiable**

```bash
claude mcp list 2>&1 | grep -iE "supabase|vercel|drawio"
```

Expected — the broken state this plan fixes:

```
claude.ai Supabase: https://mcp.supabase.com/mcp - ✔ Connected      (or absent, if already disabled)
supabase: https://mcp.supabase.com/mcp?project_ref=djftqoqbdlrhsgsfpstv (HTTP) - ! Needs authentication
```

- [ ] **Step 2: Remove the user-scoped entry**

```bash
claude mcp remove supabase -s user
```

- [ ] **Step 3: Verify it is gone**

```bash
claude mcp list 2>&1 | grep -i supabase
```

Expected: no line containing `project_ref=djftqoqbdlrhsgsfpstv`. If `claude.ai Supabase` still appears as Connected, disable it in claude.ai connector settings before continuing — see Global Constraints.

- [ ] **Step 4: Confirm nothing else was disturbed**

```bash
claude mcp list 2>&1 | grep -cE "^(context7|playwright|drawio|vercel):"
```

Expected: `4`. The removal must not have touched the other user-scoped servers.

- [ ] **Step 5: No commit**

`~/.claude.json` is not under version control. Nothing to commit for this task.

---

## Task 2: Scope Glasshouse to its own project

**Files:**
- Create: `C:/dev/glasshouse/.mcp.json`
- Test: `claude mcp list` + a live `list_tables` call

**Interfaces:**
- Consumes: the free `supabase` name from Task 1.
- Produces: a `supabase` MCP server, available only inside `C:/dev/glasshouse`, exposing project-level tools (`list_tables`, `execute_sql`, `apply_migration`, `get_advisors`, `get_logs`, …) bound to `smzccpjmakavoxlsrvku`, and **not** exposing account-level tools (`list_projects`, `create_project`, `pause_project`, …).

- [ ] **Step 1: Create the project-scoped config**

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=smzccpjmakavoxlsrvku"
    }
  }
}
```

Write to `C:/dev/glasshouse/.mcp.json`.

- [ ] **Step 2: Restart Claude Code in this repo and approve the config**

Claude Code prompts to trust a newly-added `.mcp.json` on first load. Approve it. This records the server in `projects["C:/dev/glasshouse"].enabledMcpjsonServers`.

Verify the approval landed. **`.mcp.json` trust is keyed by directory path**, so in a worktree the entry sits under the worktree's path, not `C:/dev/glasshouse` — resolve it from the current directory rather than hardcoding:

```bash
python -c "
import json,os,pathlib
d=json.load(open(os.path.expanduser('~/.claude.json'),encoding='utf-8'))
key=pathlib.Path.cwd().as_posix()
print(key,'->',(d['projects'].get(key) or {}).get('enabledMcpjsonServers'))
"
```

Expected: `['supabase']` for the directory you are actually working in. The main checkout gets its own trust prompt after this branch merges — expected, not a regression.

- [ ] **Step 3: Authenticate**

Run `/mcp`, select `supabase`, and complete the browser OAuth flow. A fresh grant is required — the URL differs from any previously authorized one (see Global Constraints).

- [ ] **Step 4: Verify it connects and is correctly scoped**

```bash
claude mcp list 2>&1 | grep -i supabase
```

Expected:

```
supabase: https://mcp.supabase.com/mcp?project_ref=smzccpjmakavoxlsrvku (HTTP) - ✔ Connected
```

- [ ] **Step 5: Verify it reaches the right database — the real acceptance test**

Call `mcp__supabase__list_tables`.

Expected: Glasshouse's schema — `claude_events` present, alongside the `public_*` views (`public_tool_totals`, `public_skill_totals`, `public_plugin_adoption`, `public_user_directory`, `public_profile_events`).

FAIL if you see meal-tracker's tables. FAIL if `list_tables` does not exist.

- [ ] **Step 6: Verify the guardrail actually holds**

Attempt `mcp__supabase__list_projects`.

Expected: **the tool does not exist.** `project_ref` disables account-level tools, so there is no path from this repo to `clotta-meal-tracker`. If `list_projects` is callable, the scope is not in effect — stop and re-check the URL in Step 1.

- [ ] **Step 7: Commit**

```bash
git add .mcp.json
git commit -m "Scope the Supabase MCP to this project

A single user-scoped server pinned project_ref=djftqoqbdlrhsgsfpstv
(clotta-meal-tracker) followed every repo, so an agent working here
reached the wrong database. project_ref also disables account-level
tools, making a cross-project migration impossible rather than unlikely."
```

---

## Task 3: Scope meal-tracker to its own project

**Files:**
- Create: `C:/dev/meal-tracker-top/meal-tracker/.mcp.json`
- Test: `claude mcp list` + a live `list_tables` call

**Interfaces:**
- Consumes: the free `supabase` name from Task 1.
- Produces: a `supabase` MCP server available only inside the meal-tracker repo, bound to `djftqoqbdlrhsgsfpstv`. Same tool surface as Task 2, different database.

- [ ] **Step 1: Create the project-scoped config**

```json
{
  "mcpServers": {
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=djftqoqbdlrhsgsfpstv"
    }
  }
}
```

Write to `C:/dev/meal-tracker-top/meal-tracker/.mcp.json`.

- [ ] **Step 2: Confirm it will be tracked, not ignored**

```bash
git -C /c/dev/meal-tracker-top/meal-tracker check-ignore -v .mcp.json; echo "exit=$?"
```

Expected: `exit=1` with no output — the file is not ignored. That repo's `.gitignore` has `.playwright-mcp/`, which does not match `.mcp.json`, but confirm rather than assume.

- [ ] **Step 3: Start Claude Code in that repo, approve, authenticate**

Approve the `.mcp.json` trust prompt, then `/mcp` → `supabase` → complete OAuth. This is a separate grant from Task 2's; the URLs differ.

- [ ] **Step 4: Verify connection and scope**

```bash
claude mcp list 2>&1 | grep -i supabase
```

Expected:

```
supabase: https://mcp.supabase.com/mcp?project_ref=djftqoqbdlrhsgsfpstv (HTTP) - ✔ Connected
```

- [ ] **Step 5: Verify it reaches meal-tracker's database**

Call `mcp__supabase__list_tables`.

Expected: meal-tracker's schema — `entries`, `foods`, `frida_foods`, `settings` (created by `supabase/migrations/0001_initial.sql` through `0005_frida_foods.sql`).

FAIL if `claude_events` appears — that would mean it is pointed at Glasshouse.

- [ ] **Step 6: Commit**

```bash
git -C /c/dev/meal-tracker-top/meal-tracker add .mcp.json
git -C /c/dev/meal-tracker-top/meal-tracker commit -m "Scope the Supabase MCP to this project

Replaces a user-scoped global server that carried this project's ref
into every other repo on the machine."
```

---

## Task 4: Document the scope in both repos

**Files:**
- Modify: `C:/dev/glasshouse/CLAUDE.md`
- Modify: `C:/dev/meal-tracker-top/meal-tracker/CLAUDE.md`

**Interfaces:**
- Consumes: the working configs from Tasks 2 and 3.
- Produces: nothing consumed by later tasks.

Rationale: the global CLAUDE.md requires docs to be updated in the same session as an architecture change. Without this, the next person to hit an auth prompt "fixes" it by adding a global server and silently reintroduces the bug.

- [ ] **Step 1: Add a section to Glasshouse's CLAUDE.md**

Append after the `## Deployment` section:

```markdown
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
```

- [ ] **Step 2: Add the equivalent to meal-tracker's CLAUDE.md**

```markdown
## Supabase access

`.mcp.json` pins the Supabase MCP to `project_ref=djftqoqbdlrhsgsfpstv`
(**clotta-meal-tracker**, `eu-west-2`), matching `.env.local`.

`project_ref` disables account-level tools, so this repo cannot reach any
other Supabase project. Do not add an unscoped `supabase` server at user
scope — that is the misconfiguration this replaced. Re-authenticate the
scoped entry with `/mcp` if prompted.
```

- [ ] **Step 3: Verify the Glasshouse CLAUDE.md stayed within its size budget**

```bash
wc -l /c/dev/glasshouse/CLAUDE.md
```

The global CLAUDE.md requires an audit above ~100 lines. If this pushes it over, move the section to `docs/supabase.md` and leave a one-line pointer, matching how `docs/hook.md` and `docs/recording_skills.md` are already referenced.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the scoped Supabase MCP and why it must stay scoped"
```

```bash
git -C /c/dev/meal-tracker-top/meal-tracker add CLAUDE.md
git -C /c/dev/meal-tracker-top/meal-tracker commit -m "Document the scoped Supabase MCP"
```

---

## Out of scope

Found during diagnosis, deliberately not in this plan — each is independent and none blocks the above:

- **`vercel` is duplicated** (`vercel` and `claude.ai Vercel`, both `mcp.vercel.com`, both `! Needs authentication`) — the same duplicate-OAuth-registration problem, unsolved. Vercel's MCP has no project-scoping query param, so the fix is "delete one", not "scope both".
- **`drawio` fails to connect** — `npx -y @drawio/mcp` returns `-32000: Connection closed`. Already suppressed per-project via `disabledMcpServers` in two repos; the user-scoped entry should probably just be removed.
- **14 unauthenticated claude.ai connectors** (Asana, Box, Canva, ClickUp, Figma, Gamma, HubSpot, Intercom, Linear, monday.com, Operating, Otter.ai, Snowflake, Webflow) contribute ~28 dead tool names to every tool search. Disconnecting is done in claude.ai connector settings, not the `claude mcp` CLI.
- **`backlog.md` #5** (two Supabase servers rendering as near-identical labels) is partly resolved by Task 1: with `claude.ai Supabase` disabled and the local entry scoped, future events carry one label per service. The historical split rows remain, so the item still needs a decision about old data.
