# Glasshouse

**Glasshouse** is a public, shared analytics pipeline for how people use Claude Code. It captures usage data (CLAUDE.md content, hooks, skills, MCP usage, time-per-permission-mode) via hooks and ships it to Supabase, with a Vercel-hosted dashboard for browsing the results.

Dashboard access requires sign-in—raw database access is never handed out.

## Installation

Works in the Claude Code CLI and in the **Code tab of the Claude Desktop app**. Requires **Node.js 18+** — Claude Code ships its own runtime and no longer installs Node, so having Claude Code is not enough.

The shortest route, in either one, is to paste this into a session and let Claude do it:

> Install the Glasshouse plugin from the marketplace at ThorxNxEriksen/Glasshouse

Or, in the CLI:

```
/plugin marketplace add ThorxNxEriksen/Glasshouse
/plugin install glasshouse@glasshouse
```

Installing by hand in the desktop app takes an extra step, and there is one button that looks right but is not — see [`docs/installing_glasshouse.md`](docs/installing_glasshouse.md), which also covers what differs on Desktop (per-session worktrees, cloud sessions, SSH).

No git clone, no install script, no flags. The next time you start Claude Code, you'll be asked once, globally, for the email address to associate with Glasshouse data. Then, the first time Claude works in any given repository, you'll be asked two separate questions for that repo:

1. **CLAUDE.md-sharing level** — how much of your CLAUDE.md you'd like to share with Glasshouse:
   - None (no CLAUDE.md content)
   - Redacted (headings only, default and recommended)
   - Full (entire CLAUDE.md)

2. **Activity sharing** — whether to share your activity data (tool invocations, skill usage, MCP usage, permission-mode timing):
   - Yes (share activity data)
   - No (don't share activity data)

Once you've answered these questions for a repository, no further prompts appear for it—the hook records events silently in the background according to your choices.

## How it works

When enabled for a repository, Glasshouse records:

- Hook events (SessionStart, InstructionsLoaded, PreToolUse, SessionEnd)
- Which tool was used, when, and (for file-based tools) the file path involved — not the command, file contents, or other tool arguments
- Which permission mode you're in over time (plan/auto/manual/etc.), used to measure time-per-mode — not what you approved or denied
- Timing and metadata from your Claude Code session

All data is sent to the shared Glasshouse Supabase project. You can then browse it via the Glasshouse dashboard (requires sign-in).

## Local development / contributing

Working on the hook itself? Read [`docs/hook.md`](docs/hook.md) first. Point your own `~/.claude/settings.json` at the working-tree copy instead of the plugin cache, for fast iteration:

```bash
git clone https://github.com/ThorxNxEriksen/Glasshouse.git
cd Glasshouse
node install.mjs
```

Run `node glasshouse-plugin/glasshouse.mjs --self-check` and `node install.mjs --self-check` before sending a PR.
