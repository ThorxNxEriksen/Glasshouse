# Glasshouse

**Glasshouse** is a public, shared analytics pipeline for how people use Claude Code. It captures usage data (CLAUDE.md content, hooks, skills, MCP usage, time-per-permission-mode) via hooks and ships it to Supabase, with a Vercel-hosted dashboard for browsing the results.

Dashboard access requires sign-in—raw database access is never handed out.

## Installation

### Step 1: Get the repository

Clone this repository and ensure you have the hook script and installer in your local copy:

```
hooks/glasshouse.mjs      — the Claude Code hook that captures events
install.mjs               — the one-shot installer
```

### Step 2: Run the installer

Run the installer once with your Supabase project credentials:

```bash
node install.mjs --url <supabase-url> --key <publishable-key> --email <your-email>
```

The installer will:

- Write `~/.claude/glasshouse/config.json` containing your Supabase project URL, publishable key, and email address
- Copy `glasshouse.mjs` to `~/.claude/hooks/glasshouse.mjs`
- Merge hook entries into `~/.claude/settings.json` (nothing else in that file is modified)

### Step 3: Use Claude Code normally

After installation, open Claude Code and work in any repository. The first time Claude works in a new repository, it will ask you via a confirmation dialog:

- Whether you'd like to share your CLAUDE.md content and activity with Glasshouse
- Confirmation of the sharing level (which is also recorded in that repository's local consent record)

Once you've answered the questions for a repository, no further prompts appear—the hook records events silently in the background.

## How it works

When enabled for a repository, Glasshouse records:

- Hook events (SessionStart, InstructionsLoaded, PreToolUse, SessionEnd)
- Tool invocations and their inputs (with sensitive command content redacted to just the tool/command name)
- Permission prompts and your choices
- Timing and metadata from your Claude Code session

All data is sent to your Supabase project. You can then browse it via the Glasshouse dashboard (requires sign-in).

## What to do next

If you're setting up the full Glasshouse pipeline:

1. Create a Supabase project and obtain its URL and publishable key
2. Run this installer against your development machine
3. Verify the consent flow works by opening a test repository in Claude Code
4. Check the Supabase dashboard to confirm events are being recorded
5. Deploy the frontend dashboard to Vercel and configure it to point to your Supabase project

See `PLAN.md` for the full implementation design.
