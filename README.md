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

After installation, open Claude Code and work in any repository. The first time Claude works in a new repository, you'll be asked two separate questions:

1. **CLAUDE.md-sharing level** — how much of your CLAUDE.md you'd like to share with Glasshouse:
   - None (no CLAUDE.md content)
   - Redacted (headings only, default and recommended)
   - Full (entire CLAUDE.md)

2. **Activity sharing** — whether to share your activity data (tool invocations, skill usage, MCP usage, permission-mode timing):
   - Yes (share activity data)
   - No (don't share activity data)

Once you've answered these questions for a repository, no further prompts appear—the hook records events silently in the background according to your choices.

## How it works

When enabled for a repository, Glasshouse records:

- Hook events (SessionStart, InstructionsLoaded, PreToolUse, SessionEnd)
- Tool invocations and their inputs (with sensitive command content redacted to just the tool/command name)
- Permission prompts and your choices
- Timing and metadata from your Claude Code session

All data is sent to your Supabase project. You can then browse it via the Glasshouse dashboard (requires sign-in).
