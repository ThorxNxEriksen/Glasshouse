# Recording skill usage

How Claude Code actually exposes skill invocations to hooks, and what Glasshouse
does with that. Written because the first implementation silently discarded every
skill name for weeks, on the strength of one wrong sentence in `PLAN.md`.

**Provenance.** Everything below marked *Verified* was checked on 2026-08-03
against Claude Code `2.1.220`, Node `v24.15.0`, Windows 11, against real
transcripts in `~/.claude/projects/` and a live round-trip into the Glasshouse
Supabase project. Claims marked *Unverified* were not tested — treat them as
open questions, not facts. Re-run the recipes in [§6 Re-verifying](#6-re-verifying)
after any Claude Code upgrade; none of this is a documented, stable API.

---

## 1. The three ways a skill activates

Only one of them is a tool call. This is the single most important thing on this
page: "skill usage" is not one measurement, it is three different events with
three different observability stories.

| Path | How it activates | Produces a `Skill` tool call? | Observable by a hook? |
|---|---|---|---|
| **Model-invoked** | Claude decides a skill applies and calls the `Skill` tool | Yes | Yes — `PreToolUse` |
| **User slash command** | User types `/skill-name`, harness routes it to the `Skill` tool | Yes | Yes — `PreToolUse` |
| **Plugin-injected (always-on)** | Plugin's own `SessionStart` hook prints the skill text as `additionalContext` | **No** | **No** — see §5 |

The first two are indistinguishable in the payload. The hook sees an identical
`Skill` tool call whether Claude chose the skill or the user typed `/skill`. So
the mock's "you vs. Claude" split on the profile page is **not implementable**
from hook data — do not try to resurrect it without a new signal.

> A `UserPromptSubmit` hook could in principle catch a literal `/skill-name`
> prompt and recover the "user typed it" case. *Unverified* — not attempted, and
> prompt text is far more sensitive than a skill name, so it would need its own
> consent gate.

---

## 2. The payload shape (verified)

A skill invocation arrives as an ordinary `PreToolUse` event. The critical
detail:

> **`tool_name` is the literal string `"Skill"` for every skill invocation.**
> It is never the skill's own name. The name lives in `tool_input.skill`.

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Skill",
  "tool_input": {
    "skill": "superpowers:brainstorming",
    "args": "Build a small Vercel food/calorie tracker app for …"
  },
  "session_id": "…",
  "cwd": "C:\\dev\\glasshouse",
  "permission_mode": "plan"
}
```

Real `tool_input` values harvested from transcripts, showing both naming forms:

```
{"skill":"run"}                                        <- user/project skill, bare name
{"skill":"claude-api"}                                 <- bare name
{"skill":"ponytail:ponytail-help"}                     <- plugin skill, plugin:skill
{"skill":"superpowers:brainstorming","args":"Build a…"} <- plugin skill + args
{"skill":"impeccable:impeccable","args":"Recolour two…"}
```

**Naming convention:** plugin skills are `plugin:skill`; user- and project-level
skills are bare. `skill_name` therefore doubles as a plugin attribution key —
split on the first `:` to group by plugin. Note the plugin *component* here
(`ponytail`) is not the same string as the `enabledPlugins` key
(`ponytail@ponytail`, i.e. `plugin@marketplace`); strip at `@` before joining
the two.

**MCP tools work the opposite way** and are the reason the original mistake was
plausible: for MCP, identity *is* in `tool_name` (`mcp__<server>__<tool>`), with
nothing extra needed from `tool_input`. Skills are the exception, not the rule.

### `args` is radioactive

`tool_input.args` sits directly beside `skill` and carries **free-text user
content** — the transcript samples above include entire project briefs and
client context. The skill *name* is a public marketplace identifier and safe to
share; `args` is arbitrary proprietary text.

Glasshouse captures the name and **never** the args. This is enforced, not just
intended — `glasshouse.mjs --self-check` asserts it:

```js
assert.strictEqual(JSON.stringify(skillRow).includes(secretArgs), false);
```

Anyone widening the `sanitizeRaw` whitelist to include `args` fails the check.
Do not "fix" that assertion.

---

## 3. What Glasshouse stores

`sanitizeRaw` reduces `tool_input` to a strict two-key whitelist, and `buildRow`
promotes the name to a real column:

```js
// sanitizeRaw, PreToolUse branch — whitelist, never a blacklist
sanitized.tool_input = {
  file_path: sanitized.tool_input.file_path ?? null,
  skill: sanitized.tool_input.skill ?? null,
};

// buildRow, PreToolUse branch
row.skill_name = payload?.tool_input?.skill ?? null;
```

Relevant schema (see `schema.sql` for the full definition):

| Column | Type | Meaning |
|---|---|---|
| `tool_name` | `text` | `"Skill"` for every skill invocation |
| `skill_name` | `text` | The skill's actual name; `null` on non-skill rows **and on rows written before 2026-08-03** |
| `enabled_plugins` | `jsonb` | Array of enabled plugin ids, `SessionStart` rows only (§5) |

Plus `claude_events_skill_name_idx` (partial, `where skill_name is not null`) and
the `session_skill_usage` view — same shape as `session_tool_usage`, one grain
finer, because `tool_name` alone cannot distinguish two different skills.

Both are gated on **activity** consent, identically to tool/MCP usage,
permission-mode timing, and `repo_name`. `enabled_plugins` is explicitly nulled when
`consent.activity !== "yes"`, so it cannot become a side channel.

**Known limitation:** `public_user_directory` lists any user with a non-null
`user_email` from *any* event, not just activity-consented ones —
`InstructionsLoaded` rows send `user_email` regardless of `consent.activity`,
gated only on `claudeMd` sharing. So a user who declines activity sharing but
accepts CLAUDE.md sharing still appears in the public directory with a
`run_count`, even though they never opted into activity metrics. Not fixed
here; the view/gating logic needs a follow-up.

### Historical rows are null, permanently

The name was destroyed at capture time for every skill call before 2026-08-03 —
it was never in the database, so it cannot be backfilled. Those rows still count
as timeline events (`tool_name = 'Skill'`), just not per-name. The profile card
footnotes the difference rather than silently under-reporting:

```
untypedSkillCalls = allTools["Skill"] - totalSkillCalls
```

---

## 4. Subagents are captured, under the parent session (verified)

Skill calls made *inside* a subagent **do** fire the parent's `PreToolUse` hook,
and are attributed to the **parent** `session_id` and the parent's `cwd`. There
is no undercount.

Verified by matching transcript timestamps against database rows for session
`e9005121-…`. Its main transcript has 3 skill calls and one subagent transcript
has a 4th; the database has exactly 4 rows, including the subagent's:

| Transcript | Skill | Transcript ts | DB `client_ts` | Δ |
|---|---|---|---|---|
| main | `impeccable:impeccable` | `09:04:59.601Z` | `09:04:59.88` | +0.3s |
| main | `intellishore:ui-design-system` | `09:04:59.644Z` | `09:05:04.034` | +4.4s |
| main | `superpowers:subagent-driven-development` | `09:12:08.428Z` | `09:12:09.161` | +0.7s |
| **subagent** | `andrej-karpathy-skills:karpathy-guidelines` | `09:30:57.519Z` | `09:30:57.867` | +0.3s |

Consequences for analysis:

- A per-session skill count is a count across the session **and all its
  subagents**. It is not "what the main loop did".
- Subagent skill calls cannot be separated from main-loop ones in
  `claude_events` — the payload carries no subagent id. The distinction only
  exists in the local transcript's `subagents/` directory. *Unverified* whether
  any hook payload exposes a subagent identifier.
- The Δ column shows hook write latency is sub-second but not fixed (4.4s on one
  row, likely hook serialization behind another event). **Never** use
  `client_ts` ordering to reconstruct sub-second event order.

---

## 5. Always-on skills: why they are invisible

`superpowers` and `ponytail` are active in essentially every session on this
machine, and **neither ever appears as a `Skill` tool call**. There is nothing to
count. Three separate mechanisms conspire here.

**(a) They inject via `SessionStart`, not via a tool call.** A `SessionStart`
hook exits 0 and prints:

```json
{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "…skill text…"}}
```

Claude Code wraps that string in a system-reminder and inserts it into the
conversation. The skill is fully in context, with no tool call and no
`PreToolUse` event. (This is the same mechanism Glasshouse itself uses to ask for
consent.)

**(b) Plugin hooks are declared in the plugin manifest, not in
`~/.claude/settings.json`.** Verified — `ponytail`'s
`.claude-plugin/plugin.json` contains:

```json
{ "name": "ponytail", "version": "4.8.4", "hooks": "./hooks/claude-codex-hooks.json" }
```

and that file registers `SessionStart` (matcher
`startup|resume|clear|compact`), `SubagentStart`, and `UserPromptSubmit`. None of
this is in `settings.json`. So `installed_hooks` — which reads
`settings.json`'s `hooks` block — **cannot see plugin hooks at all**. During the
session that verified this, `settings.json` listed only Glasshouse and
`block-destructive-git`, while ponytail was demonstrably running.

**(c) Therefore the only local signal is `enabledPlugins`,** in that same
`settings.json`:

```json
{
  "superpowers@claude-plugins-official": true,
  "ponytail@ponytail": true,
  "drawio@365-skills": false
}
```

Disabled plugins are **present but `false`** — filter on the value, never on key
presence:

```js
Object.keys(plugins).filter((name) => plugins[name] === true).sort()
```

### Report presence, not counts

An always-on skill loads unconditionally, every session. "You used ponytail 47
times" would be fiction — the number would just be a session count wearing a
disguise. The profile page therefore splits the skills card in two:

- **Invoked** — per-name bars from `skill_name`. A real measurement.
- **Always on** — tags from `enabled_plugins`. Presence only, explicitly labelled
  "active, not counted".

Known limits of `enabled_plugins`:

- It is a **plugin** roster, not a skill roster. A plugin ships many skills;
  enabling it does not mean all of them loaded. It answers "which skill packs
  were active", not "which skill text entered context".
- It is written on `SessionStart` only, so it lags a mid-session `/plugin`
  toggle by one session.
- It cannot distinguish "plugin enabled and injected a skill" from "plugin
  enabled but idle all session".
- *Unverified:* project-level `.claude/settings.json` may also carry
  `enabledPlugins`. Glasshouse reads the user-level file only, so a
  project-scoped plugin would be missed.

---

## 6. Re-verifying

All read-only except the last. Run after any Claude Code upgrade.

**Skill payload shape, from local transcripts:**

```bash
cd ~/.claude/projects && \
  grep -rho '"name":"Skill","input":{[^}]*}' --include=*.jsonl . | sort -u
```

**Confirm `tool_name` is `"Skill"` and args never landed:**

```sql
select tool_name, skill_name, raw->'tool_input' as tool_input
from claude_events where tool_name = 'Skill'
order by client_ts desc limit 10;
-- tool_input must only ever have keys: file_path, skill
```

**Which plugin hooks exist (invisible to `installed_hooks`):**

```bash
cat ~/.claude/plugins/cache/<plugin>/<plugin>/<version>/.claude-plugin/plugin.json
# follow its "hooks" path to see the registered events
```

**Confirm subagent capture:** list Skill calls with timestamps from a session's
main transcript and its `subagents/*.jsonl`, then compare the count and
timestamps against `select client_ts from claude_events where tool_name='Skill'
and session_id = '…'`. Counts should match; each subagent call should have a row
within ~1s.

**Full offline assertion suite (writes nothing, no network):**

```bash
node ~/.claude/hooks/glasshouse.mjs --self-check          # the live copy
node <repo>/glasshouse-plugin/glasshouse.mjs --self-check # the distributed copy
```

**End-to-end (writes one row):** invoke a harmless skill such as
`/ponytail-help`, then query for the newest `Skill` row and confirm `skill_name`
is populated and no `args` is present.

---

## 7. Gotchas

**There are two copies of the hook, and the repo one may not be the live one.**
`install.mjs` drops a standalone copy at `~/.claude/hooks/glasshouse.mjs`, and
that is what `settings.json` points at. Editing only
`glasshouse-plugin/glasshouse.mjs` changes nothing about your own telemetry — a
skill-capture fix applied to the repo copy alone will not appear in your own
data. The two were reconciled in `d5ec9f6` and are identical as of that commit,
but they have drifted in *both* directions before, so `diff` them before
assuming a fix is live. Details in [`hook.md`](hook.md).

**`enabled_plugins` needs a fresh session.** It is captured on `SessionStart`, so
it stays null for the session in which the change was deployed. An empty "Always
on" card immediately after deploying is expected, not a bug.

**Don't infer skills from CLAUDE.md.** A CLAUDE.md line like "invoke the
`impeccable` skill before design work" is an *instruction*, not evidence the
skill ran. Instruction content is captured under a different consent gate
(`claudeMd`) and must not be mixed into activity metrics.

**None of this is a stable API.** `tool_input.skill`, `enabledPlugins`, and the
plugin-manifest hook layout are all internal shapes observed empirically. Every
reader in this repo already tolerates absence (`?? null`, `?? []`), and it should
stay that way: a Claude Code upgrade that renames a field must degrade to "no
data", never crash a hook on someone's machine.

---

## 8. Open questions

- Does `PostToolUse` for a `Skill` call carry a result worth capturing (e.g.
  whether the skill actually loaded vs. errored)? *Unverified* — Glasshouse
  registers `PreToolUse` only.
- Is there any payload field identifying the subagent that made a call? Would
  let us split main-loop from subagent usage (§4).
- Can the user-typed `/skill` case be recovered from `UserPromptSubmit` (§1),
  and is it worth a separate consent gate?
- Do project-level `.claude/settings.json` files carry `enabledPlugins` (§5)?
- `SubagentStart` exists as a hook event (seen in ponytail's manifest) and is
  currently uncaptured. Might be a cleaner subagent-count signal than counting
  `Agent` tool calls.
