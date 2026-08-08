# Installing Glasshouse

Glasshouse works the same in the Claude Code CLI and in the **Code tab of the Claude
Desktop app** — both run the same engine and read the same `~/.claude/settings.json`, so
hooks defined there fire in both. What differs is how you install it and a handful of
desktop behaviours worth knowing about.

## Prerequisites

**Node.js 18 or newer.** This is the one that catches people out. Claude Code's native
installer and the desktop app ship a single self-contained binary with its own runtime, so
Claude Code no longer installs Node and having Claude Code is no longer evidence that you
have it. Glasshouse's hook is a Node script; without Node it records nothing.

You do not have to check by hand. If Glasshouse cannot find a Node runtime it says so once
at the start of a session and then stays quiet — it never fails a tool call over it. It
looks on `PATH` first, then in the usual nvm, fnm, volta, Homebrew and
`C:\Program Files\nodejs` locations, because hooks run without your shell profile and a
version-manager install is invisible to them otherwise.

**Git**, for repository identity. The desktop app's Code tab already requires Git for
Windows, so this is only worth checking on the CLI.

**A POSIX shell.** Present by default on macOS and Linux. On Windows it comes from Git for
Windows, which the desktop Code tab requires anyway. A Windows CLI user with no Git Bash
is the one configuration Glasshouse cannot run in — Claude Code falls back to PowerShell
for shell-form hooks there, and the launcher is a `sh` script.

## Install

### The short way, in either the CLI or the desktop app

Paste this into a session and let Claude do it:

> Install the Glasshouse plugin from the marketplace at ThorxNxEriksen/Glasshouse

No terminal, no editor, no JSON. Claude runs the two commands below for you, and
`/reload-plugins` activates the result.

### In the CLI

```
/plugin marketplace add ThorxNxEriksen/Glasshouse
/plugin install glasshouse@glasshouse
```

### In the Claude Desktop app, by hand

The Code tab's plugin browser (**+** next to the prompt box → **Plugins** → **Add
plugin**) lists plugins from marketplaces you have already configured. It has no way to
add a new one, so Glasshouse will not appear there until the marketplace is registered.

Register it from the integrated terminal (**Ctrl+`**, local sessions only):

```
claude plugin marketplace add ThorxNxEriksen/Glasshouse
claude plugin install glasshouse@glasshouse
```

Then `/reload-plugins`.

## What is different on Desktop

**Every session gets its own git worktree.** For git repositories the desktop app isolates
each session in a worktree under `<project-root>/.claude/worktrees/`. Two consequences:

- `git_branch` records the session's worktree branch, not the branch you think you are on.
- Consent is keyed on your `origin` remote, so it survives worktrees and you answer the two
  questions once per repository. **A git repository with no `origin` remote is the
  exception**: the key falls back to the directory path, which is different for every
  worktree, so Glasshouse re-asks both consent questions every session. Add a remote and it
  settles down. A plain folder that is not a git repository never gets a worktree and is
  unaffected.

**Cloud sessions record nothing.** Sessions you run on Anthropic's infrastructure have no
persistent `~/.claude`, so there is no email or consent on file and nothing is captured.
Glasshouse says so once per cloud session and does not ask you for anything, because any
answer would be discarded with the VM. Your local sessions are unaffected.

**SSH and WSL sessions are separate machines.** An SSH session reads the remote host's
`~/.claude`, so Glasshouse needs its own email and consent answers there. Plugins are not
available in WSL sessions at all.

**The Cowork tab is out of scope.** It sources its configuration from your claude.ai
account rather than `~/.claude`, so Glasshouse does not see it.

**Customize → Plugins is not a separate world.** Plugins installed into `~/.claude` do
show up there — observed in the Code tab, with `~/.claude`-installed plugins listed. What
the **Add marketplace** button in that panel writes to has not been tested, so install via
the routes above rather than through it.

## Contributing

Working on the hook itself? See [`hook.md`](hook.md), which covers the two-copies problem
and the exit invariant. Point your own `~/.claude/settings.json` at the working-tree copy:

```bash
git clone https://github.com/ThorxNxEriksen/Glasshouse.git
cd Glasshouse
node install.mjs
```

`install.mjs` writes to `~/.claude/`, which is machine-wide — a git worktree does not
isolate it.
