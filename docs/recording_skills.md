# Recording skill usage

How Claude Code actually exposes skill invocations to hooks, and what Glasshouse
does with that. Written because the first implementation silently discarded every
skill name for weeks, on the strength of one wrong sentence in `PLAN.md`.

**Provenance.** Everything below marked *Verified* was checked on 2026-08-03
against Claude Code `2.1.220`, Node `v24.15.0`, Windows 11, against real
transcripts in `~/.claude/projects/` and a live round-trip into the Glasshouse
Supabase project. §1, §5, §5.1, §5.2 and §8 were revised on 2026-08-04 against
`superpowers@6.2.0` / `ponytail@4.8.4` / `vercel-plugin@1e821f3087d6` plugin manifests
and a live round-trip of the `always_on_skills` column — that revision corrected a false
claim in the original §5, which is quoted and marked in place rather than deleted. Claims marked *Unverified* were not tested — treat them as
open questions, not facts. Re-run the recipes in [§6 Re-verifying](#6-re-verifying)
after any Claude Code upgrade; none of this is a documented, stable API.

---

## 1. The four ways a skill's text enters context

Two of them are `Skill` tool calls. This is the single most important thing on
this page: "skill usage" is not one measurement, it is four different events with
four different observability stories.

| Path | How it activates | Produces a `Skill` tool call? | Observable by a hook? |
|---|---|---|---|
| **Model-invoked** | Claude decides a skill applies and calls the `Skill` tool | Yes | Yes — `PreToolUse` |
| **User slash command** | User types `/skill-name`, harness routes it to the `Skill` tool | Yes | Yes — `PreToolUse` |
| **Entry-point injection (always-on)** | Plugin's own `SessionStart` hook prints **one** skill's text as `additionalContext` | **No** | Not as an event, but the skill is *named* in `always_on_skills` — §5, §5.2 |
| **Progressive disclosure** | An already-loaded skill tells Claude to `Read` one of its own sub-files | No | Yes — as a `Read` `PreToolUse` with `file_path`; see §5.1 |

The first two are indistinguishable in the payload. The hook sees an identical
`Skill` tool call whether Claude chose the skill or the user typed `/skill`. So
the mock's "you vs. Claude" split on the profile page is **not implementable**
from hook data — do not try to resurrect it without a new signal.

### Do not confuse "the plugin is always on" with "its skills are invisible"

The single most misleading thing you can believe about this pipeline (and an
earlier revision of §5 said it outright) is that an always-on plugin's skills are
uncountable. They are not. **A plugin injects exactly one entry-point skill; every
other skill it ships is an ordinary `Skill` tool call and is fully captured.**

Verified 2026-08-04 against `superpowers@6.2.0`, which ships 14 skills.
`hooks/session-start` reads precisely one file:

```bash
using_superpowers_content=$(cat "${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md")
```

So 1 skill is injected and 13 — `brainstorming`, `systematic-debugging`,
`subagent-driven-development`, … — are countable. `ponytail@4.8.4` is structurally
identical: `hooks/ponytail-activate.js` injects the `ponytail` skill at
`SessionStart`, while `ponytail-help`, `ponytail-review`, `ponytail-audit`,
`ponytail-debt` and `ponytail-gain` are ordinary tool calls. Both halves are
present in live data — `superpowers:brainstorming` and `ponytail:ponytail-help`
each have rows.

**Why the confusion is easy.** Skill *discovery* and skill *loading* are separate.
At session start the harness injects a one-line `name: description` entry for
every available skill so Claude knows what exists; the `SKILL.md` body loads only
on demand. That on-demand load *is* the `Skill` tool call. The moment you would
most want to observe is the one moment that is loudest in the hook stream.

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
| `always_on_skills` | `jsonb` | `[{plugin, skill}]` for plugins that inject at `SessionStart`; a strict subset of `enabled_plugins`, `SessionStart` rows only (§5.2) |

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

## 5. Entry-point skills: why they are invisible

> **Corrected 2026-08-04.** This section used to open with "`superpowers` and
> `ponytail` … **neither ever appears as a `Skill` tool call**. There is nothing to
> count." That is **false**, and it contradicted §2 of this very document, which
> lists `{"skill":"superpowers:brainstorming",…}` among its harvested transcript
> samples. It swapped *the plugin* for *the plugin's entry-point skill*. The
> invisible set is **2 skills** (`superpowers:using-superpowers`,
> `ponytail:ponytail`), not 2 plugins. See §1 for the corrected model; the
> mechanics below are accurate and unchanged.

The one skill a plugin injects at `SessionStart` never appears as a `Skill` tool
call, so for that skill there is nothing to count. Three separate mechanisms
conspire here.

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

An entry-point skill loads unconditionally, every session. "You used ponytail 47
times" would be fiction — the number would just be a session count wearing a
disguise. The profile page therefore splits the skills card in two:

- **Invoked** — per-name bars from `skill_name`. A real measurement.
- **Always on** — tags from `enabled_plugins`. Presence only, explicitly labelled
  "active, not counted".

Since 2026-08-04 the "Always on" section names the entry-point **skill**, from the
`always_on_skills` column (§5.2) — not the plugin. The plugin roster moved to its own
card, because "which plugins are installed" is configuration and belongs next to hooks,
not on the same axis as a measured invocation. See §8 for the three tiers.

Known limits of `enabled_plugins`:

- It is a **plugin** roster, not a skill roster. A plugin ships many skills;
  enabling it does not mean all of them loaded. It answers "which skill packs
  were available", not "which skill text entered context". Do **not** read it as
  "these skills are uncountable" — see §1. For the one skill per plugin that
  genuinely is uncountable, use `always_on_skills` (§5.2) instead.
- It is written on `SessionStart` only, so it lags a mid-session `/plugin`
  toggle by one session.
- It cannot distinguish "plugin enabled and injected a skill" from "plugin
  enabled but idle all session".
- *Unverified:* project-level `.claude/settings.json` may also carry
  `enabledPlugins`. Glasshouse reads the user-level file only, so a
  project-scoped plugin would be missed.

### The entry-point skill is double-loaded, and partly counted

`using-superpowers` instructs Claude to invoke skills via the `Skill` tool, and
Claude sometimes applies that to `using-superpowers` itself — even though the
`SessionStart` hook already put the full text in context. Local transcripts carry
28 such redundant `{"skill":"superpowers:using-superpowers"}` calls; the database
has 2 (the rest predate skill-name capture).

So the entry-point skill is not cleanly uncounted — it is *inconsistently* counted,
which is worse. A bar for `superpowers:using-superpowers` measures how often Claude
redundantly re-invoked an already-loaded skill, not how often the skill was active
(the answer to that is: every session). Treat any entry-point skill's `skill_name`
count as noise, not signal.

---

## 5.1 Progressive disclosure: capturable today, deliberately not built

A loaded skill often defers most of its content to sibling files and tells Claude
to `Read` them on demand — `systematic-debugging/root-cause-tracing.md`,
`subagent-driven-development/task-reviewer-prompt.md`,
`brainstorming/visual-companion.md`. `superpowers@6.2.0` ships 14 `SKILL.md` files
and 36 such sub-files.

These are **not** `Skill` calls, so `skill_name` is null for them. But they are
`Read` calls, and `buildRow` already stores `row.file_path` for every `PreToolUse`
(`glasshouse.mjs:274`). **The data is already in the base table.** Verified
2026-08-04 — real rows, unprompted:

```
Read  …\superpowers\6.2.0\skills\requesting-code-review\code-reviewer.md
Read  …\superpowers\6.2.0\skills\subagent-driven-development\task-reviewer-prompt.md
Read  …\superpowers\6.2.0\skills\subagent-driven-development\scripts\task-brief
Read  …\impeccable\4.0.4\skills\impeccable\reference\craft-floor.md
```

The plugin cache path is fully structured and parseable:

```
~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill>/<sub-path>
```

Nothing needs to be *captured* to report on this — only *derived*. Two caveats
before anyone builds it:

**(a) `file_path` is deliberately unpublished, and must stay that way.**
`row.file_path` on `PreToolUse` is **not** consent-gated (unlike `permission_mode`,
`repo_name`, `enabled_plugins`) and carries absolute paths into the user's own
projects, OS username included. `public_profile_events` keeps it out by
whitelist, and reduces `raw` to `{memory_type}` for exactly this reason — see the
comment above that view in `schema.sql`. A skill-depth feature must publish a
*derived* `plugin/skill/sub-file` triple, never the path it came from, and it must
match on the plugin-cache prefix only so no project path can ever fall through.

**(b) Consent.** Skill sub-file names are public marketplace identifiers, so the
derived triple belongs under the existing **activity** gate. The raw `file_path`
it is derived from is not covered by any gate today, which is a separate open
issue (§8) and a reason to derive at capture time in the hook rather than in a view.

**Declined 2026-08-04, on purpose.** Depth of use is a genuinely different measurement —
reading 6 of `systematic-debugging`'s 10 sub-files is a stronger signal than one `Skill`
call — but it describes *a skill's internal design* more than it describes what a person
uses, and the dashboard exists so co-workers can be inspired by each other's tooling.
Sub-file counts don't serve that. This section stays as a record of a road not taken and
of where the data already sits, not as a backlog item. If it is ever revisited, the two
caveats above (published as a derived triple only; `file_path` ungated at capture) are the
binding constraints.

---

## 5.2 `always_on_skills`: naming the entry-point skill (verified 2026-08-04)

`readAlwaysOnSkills` in `glasshouse.mjs` records the entry-point skill per plugin on
`SessionStart`, gated on activity consent like `enabled_plugins`:

```json
[{"plugin":"ponytail@ponytail","skill":"ponytail:ponytail"},
 {"plugin":"superpowers@claude-plugins-official","skill":"superpowers:using-superpowers"},
 {"plugin":"vercel-plugin@vercel","skill":"vercel:knowledge-update"}]
```

It is a **strict subset** of `enabled_plugins` — 3 of 6 on the reference machine — because
a plugin only qualifies if it registers a `SessionStart` hook. That is what makes it a
different measurement rather than the same roster twice. Four details, each of which broke
a simpler implementation:

**(a) Resolve the install path from `installed_plugins.json`, don't guess it.** It keys on
the same `plugin@marketplace` string as `enabledPlugins` and gives an exact `installPath`.
The cache holds multiple versions (superpowers has both `5.1.0` and `6.2.0`) and only one
is installed. Store names only — `installPath` is absolute and contains the OS username;
a `--self-check` assertion enforces that it never reaches the row.

**(b) Hook registration has two forms and both are load-bearing.** ponytail declares
`"hooks": "./hooks/claude-codex-hooks.json"` in `.claude-plugin/plugin.json`; superpowers
has **no `"hooks"` key at all** and is auto-discovered from the conventional
`hooks/hooks.json`. Checking only the manifest silently misses superpowers — the exact
plugin this feature exists for.

**(c) The skill name is declared nowhere, so match the `SKILL.md` read.** Every plugin
observed injects by reading its own `SKILL.md`, in three different quoting styles:

```
superpowers  cat "${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md"
ponytail     path.join(__dirname, '..', 'skills', 'ponytail', 'SKILL.md')
vercel       join(pluginRoot(), "skills", "knowledge-update", "SKILL.md")
```

One regex over the `skills` → *name* → `SKILL.md` token sequence handles all three. The
capture is then intersected with the plugin's real `skills/*/` directories, so a variable
or placeholder can't pass as a skill name. Exactly one survivor → use it; zero or several
→ `null`, and the UI falls back to the plugin name.

**(d) Two plausible heuristics were tried and are wrong. Do not reintroduce them.**

| Rejected rule | Why it fails |
|---|---|
| Count how often each skill name appears in the plugin's `hooks/` dir, most mentions wins | vercel's hooks ship a skill **ranker** naming dozens of skills, so `ai-sdk` (6 files) beat `knowledge-update` (1). Frequency measures how chatty a hook is, not what it injects. |
| Bare substring match of the skill name | `eve` matched inside *every*, *never*, *level*, so `vercel:eve` won outright. Word boundaries fix this one case but not the ranker above. |

**(e) The skill prefix is the manifest `name`, not the `enabledPlugins` key.** vercel is
keyed `vercel-plugin@vercel` but ships its skills as `vercel:*`. Read `name` from
`.claude-plugin/plugin.json` and fall back to `key.split("@")[0]` only if it's absent.

Everything degrades to `[]` or `{plugin, skill: null}` — never a throw. This runs at every
session start on other people's machines.

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

**Which skill a plugin injects vs. ships (the check that catches the §5 error).**
Compare the count of shipped skills against the injected one — the difference is
what remains countable:

```bash
P=~/.claude/plugins/cache/claude-plugins-official/superpowers/6.2.0
ls "$P/skills"                       # every skill shipped (14)
grep -o 'skills/[a-z-]*/SKILL.md' "$P/hooks/session-start"   # the injected one (1)
```

If the second command returns more than one path, the entry-point model in §1 has
changed and the "Always on" card needs revisiting.

**What `always_on_skills` resolves to on this machine**, without waiting for a session.
Cut the CLI dispatch off the hook and call the function directly:

```bash
N=$(grep -n '^const mode = process.argv' glasshouse-plugin/glasshouse.mjs | cut -d: -f1)
head -$((N-1)) glasshouse-plugin/glasshouse.mjs > /tmp/probe.mjs
cat >> /tmp/probe.mjs <<'EOF'
console.log(JSON.stringify(readAlwaysOnSkills(path.join(os.homedir(), ".claude", "settings.json")), null, 2));
EOF
node /tmp/probe.mjs
```

Expect a strict subset of `enabledPlugins` with a non-null `skill` per entry. A `null`
skill means the §5.2(c) regex no longer matches that plugin's injection; a *missing*
plugin means its `SessionStart` registration moved (§5.2(b)). Neither is a crash, and
neither is visible without this check — which is why it exists.

**Progressive-disclosure reads landing in the base table (§5.1):**

```sql
select tool_name, file_path, count(*) from claude_events
where file_path ilike '%plugins%cache%skills%' group by 1,2 order by 3 desc;
-- expect Read rows for skill sub-files; must NOT be visible via public_profile_events
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

## 8. Three tiers, not two: how this is categorised

The dashboard used to model two tiers (invoked skills vs. always-on *plugins*), which
forced plugins and skills onto one axis and caused the mislabelling described in §5.
There are **three**, they answer different questions, and each now has its own column:

| Tier | Unit | Source | What it means | Countable? |
|---|---|---|---|---|
| **Plugin** | `superpowers@claude-plugins-official` | `enabled_plugins` (SessionStart) | A capability *surface* was available. Says nothing about use. | No — presence only |
| **Always-on skill** | `superpowers:using-superpowers` | `always_on_skills` (SessionStart, §5.2) | This skill is in context every session, injected, never invoked. | No — presence only |
| **Invoked skill** | `superpowers:brainstorming` | `skill_name` (PreToolUse) | This skill's body entered context on purpose. | **Yes, per name** |

A fourth tier exists in the raw data — skill sub-file reads, derivable from `file_path`
(§5.1) — and was deliberately declined.

So: **`superpowers` and `ponytail` are plugins, not skills.** They are containers that
ship skills, hooks, commands and agents. Enabling one is a configuration fact, on the same
footing as an installed hook or an MCP server; it is not an activity event.

The muddle came from each plugin also *being* roughly one always-on skill in practice,
because its entry-point skill is injected every session. But that skill has a name, and
naming it is what keeps the tiers straight — "always on: `superpowers:using-superpowers`",
never "always on: `superpowers`". As built:

- **Configuration** — enabled plugins, on their own card beside hooks.
- **Activity, uncounted** — always-on skills, tagged inside the skills card.
- **Activity, counted** — invoked skills, as bars. MCP servers sit alongside, unchanged.

Both static tiers are "as of the most recent session that reported one", so both lag a
mid-session `/plugin` toggle by one session.

---

## 9. Open questions

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
- **`file_path` on `PreToolUse` is captured with no consent gate at all** (§5.1).
  It is kept out of public views by whitelist, so it does not leak today, but every
  other identifying field is gated at *capture* time and this one is not. Should it
  be gated on activity consent, or reduced at capture to a plugin-skill triple plus
  null?
- Are user- and project-level skills (`~/.claude/skills/`, `.claude/skills/`) also
  progressively disclosed, and do their sub-file paths need the same derivation as
  the plugin-cache prefix? *Unverified* — only plugin-cache reads were observed.
