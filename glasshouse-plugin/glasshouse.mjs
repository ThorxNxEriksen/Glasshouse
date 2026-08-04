#!/usr/bin/env node
// Glasshouse hook dispatcher + consent CLI. Node built-ins only, zero deps.
//
// Invocation shapes (dispatched on process.argv):
//   node glasshouse.mjs                → hook mode (reads a Claude Code hook payload from stdin)
//   node glasshouse.mjs consent ...    → consent CLI (writes ~/.claude/glasshouse/consent.json)
//   node glasshouse.mjs set-email ...  → writes ~/.claude/glasshouse/config.json
//   node glasshouse.mjs --self-check   → offline self-check, never touches real files/network
//
// Claude Code never invokes this file directly: settings.json and plugin.json both point
// at glasshouse.sh beside it, which locates a Node runtime first and execs into here.
// Editing this file alone is therefore not enough to change what runs — see
// docs/hook.md ("Two copies of the hook") and docs/installing_glasshouse.md.
//
// Ships as part of the Claude Code plugin (${CLAUDE_PLUGIN_ROOT}/) and is also usable
// standalone via install.mjs for local development.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import http from "node:http";
import https from "node:https";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Shared Glasshouse Supabase project — the publishable key is designed to be
// public (insert-only RLS on claude_events; it cannot read anything back).
const SUPABASE_URL = "https://smzccpjmakavoxlsrvku.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_ls0imoJ332Zpd-IeehbWkg_X6Q-w8Um";

// ---------------------------------------------------------------------------
// Consent store — ~/.claude/glasshouse/consent.json, but every function here
// takes its base dir as a parameter so self-check never touches the real one.
// ---------------------------------------------------------------------------

function glasshouseDir(baseDir) {
  return path.join(baseDir, ".claude", "glasshouse");
}

function consentPath(baseDir) {
  return path.join(glasshouseDir(baseDir), "consent.json");
}

function configPath(baseDir) {
  return path.join(glasshouseDir(baseDir), "config.json");
}

function loadConsentStore(baseDir) {
  try {
    const data = JSON.parse(fs.readFileSync(consentPath(baseDir), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveConsentStore(baseDir, store) {
  try {
    fs.mkdirSync(glasshouseDir(baseDir), { recursive: true });
    fs.writeFileSync(consentPath(baseDir), JSON.stringify(store, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

function loadConfig(baseDir) {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(baseDir), "utf8"));
    if (!data || typeof data !== "object" || typeof data.userEmail !== "string" || !data.userEmail) {
      return null;
    }
    return {
      supabaseUrl: data.supabaseUrl || SUPABASE_URL,
      supabasePublishableKey: data.supabasePublishableKey || SUPABASE_PUBLISHABLE_KEY,
      userEmail: data.userEmail,
    };
  } catch {
    return null;
  }
}

function saveConfig(baseDir, config) {
  try {
    fs.mkdirSync(glasshouseDir(baseDir), { recursive: true });
    fs.writeFileSync(configPath(baseDir), JSON.stringify(config, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Repo identity
// ---------------------------------------------------------------------------

function computeRepoKey(cwd) {
  try {
    const out = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (out) return out.endsWith(".git") ? out.slice(0, -4) : out;
  } catch {
    // not a git repo, or no origin remote — fall through
  }
  return path.resolve(cwd);
}

function gitBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

// Short display name for a repo — never a full path or URL. Reuses
// computeRepoKey's git-remote-or-resolved-path logic and takes the last path
// segment either way.
function repoName(cwd) {
  const key = computeRepoKey(cwd);
  const segments = key.split(/[\\/]/).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : path.basename(cwd);
}

// ---------------------------------------------------------------------------
// CLAUDE.md redaction
// ---------------------------------------------------------------------------

// Claude Code's InstructionsLoaded payload carries file_path/memory_type/
// load_reason but not the file's text — read it ourselves when the payload
// doesn't already inline it (older/future Claude Code versions might).
function readInstructionsContent(payload) {
  const inline = payload?.content ?? payload?.instructions;
  if (typeof inline === "string" && inline) return inline;
  const filePath = payload?.file_path ?? payload?.path;
  if (typeof filePath !== "string" || !filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function redactClaudeMd(content) {
  const lines = content.split("\n");
  const totalLines = lines.length;
  const totalChars = content.length;
  const headings = lines.filter((line) => /^#+ .*/.test(line));
  headings.push(`[glasshouse: body redacted — ${totalLines} lines / ${totalChars} chars omitted]`);
  return headings.join("\n");
}

// ---------------------------------------------------------------------------
// Installed-hooks snapshot — matchers only, never command strings (those leak
// local paths/usernames into a public dataset).
// ---------------------------------------------------------------------------

function readInstalledHooks(settingsPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== "object") return {};
    const result = {};
    for (const [eventName, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) continue;
      result[eventName] = entries
        .map((entry) => entry?.matcher)
        .filter((matcher) => typeof matcher === "string");
    }
    return result;
  } catch {
    return {};
  }
}

// The enabled-plugin roster: which capability surfaces the user has installed.
// This is a *configuration* fact, not usage — a plugin ships many skills, and
// enabling it says nothing about which ones ran. For the one skill per plugin
// that genuinely can't be counted, see readAlwaysOnSkills below. Names only
// (public marketplace identifiers like "ponytail@ponytail"); no paths, no versions.
function readEnabledPlugins(settingsPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const plugins = settings?.enabledPlugins;
    if (!plugins || typeof plugins !== "object") return [];
    // Disabled entries are present-but-false, so filter on the value, not the key.
    return Object.keys(plugins).filter((name) => plugins[name] === true).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Always-on skills
//
// A plugin's own SessionStart hook can print one skill's text as
// additionalContext, putting it in context with no Skill tool call at all — and
// plugin hooks live in the plugin, not in settings.json's "hooks" block, so
// readInstalledHooks can't see them either. That one entry-point skill per plugin
// is the only genuinely dark skill: everything else a plugin ships arrives as an
// ordinary Skill call and is already captured in skill_name.
//
// Emits names only — "<plugin>@<marketplace>" and "<plugin>:<skill>", both public
// marketplace identifiers. Never installPath, which is absolute and carries the
// OS username.
// ---------------------------------------------------------------------------

// Cap per hook file so a plugin shipping a bundled megabyte can't stall the hook.
const HOOK_FILE_MAX_BYTES = 256 * 1024;

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDirNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Two registration forms are both live and both must work: ponytail declares
// "hooks": "./hooks/claude-codex-hooks.json" in its plugin.json, while superpowers
// has no "hooks" key at all and relies on Claude Code auto-discovering the
// conventional hooks/hooks.json. Checking only the manifest misses superpowers.
function readPluginHooksManifest(root) {
  const declared = readJsonFile(path.join(root, ".claude-plugin", "plugin.json"))?.hooks;
  const candidates = typeof declared === "string" && declared ? [path.resolve(root, declared)] : [];
  candidates.push(path.join(root, "hooks", "hooks.json"));
  for (const candidate of candidates) {
    const manifest = readJsonFile(candidate);
    if (manifest) return manifest;
  }
  return null;
}

function injectsAtSessionStart(root) {
  const entries = readPluginHooksManifest(root)?.hooks?.SessionStart;
  return Array.isArray(entries) && entries.length > 0;
}

// Read the hooks directory non-recursively: the scripts that do the injecting sit
// at its top level, and recursing would drag in node_modules on some plugins.
function readHookTexts(dir) {
  const texts = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return texts;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(dir, entry.name);
    try {
      if (fs.statSync(file).size > HOOK_FILE_MAX_BYTES) continue;
      texts.push(fs.readFileSync(file, "utf8"));
    } catch {
      // Unreadable file — skip it, never fail the whole scan.
    }
  }
  return texts;
}

// The injected skill's name is declared nowhere, so it has to be inferred — but
// every plugin observed injects by *reading its own SKILL.md*, and that read is a
// reliable fingerprint. Three plugins, three quoting styles, one shape:
//
//   superpowers  cat "${PLUGIN_ROOT}/skills/using-superpowers/SKILL.md"
//   ponytail     path.join(__dirname, '..', 'skills', 'ponytail', 'SKILL.md')
//   vercel       join(pluginRoot(), "skills", "knowledge-update", "SKILL.md")
//
// So match the "skills <name> SKILL.md" token sequence through arbitrary quote and
// separator noise. Do NOT go back to counting how often each skill name is
// mentioned: that looked plausible and was measurably wrong — vercel's hooks ship
// a skill *ranker* naming dozens of skills, so the most-mentioned one ("ai-sdk")
// is not the injected one, and a bare substring scan additionally matched "eve"
// inside "every"/"never".
const SKILL_MD_REF = /skills["'\s]*[,/]["'\s]*([A-Za-z0-9._-]+)["'\s]*[,/]["'\s]*SKILL\.md/g;

function inferEntryPointSkill(root) {
  const shipped = new Set(listDirNames(path.join(root, "skills")));
  if (!shipped.size) return null;

  const found = new Set();
  for (const text of readHookTexts(path.join(root, "hooks"))) {
    for (const [, name] of text.matchAll(SKILL_MD_REF)) {
      // Only trust a capture naming a directory the plugin really ships, so a
      // variable or template placeholder can't sail through as a skill name.
      if (shipped.has(name)) found.add(name);
    }
  }
  // Exactly one, or nothing safe to report — a confidently wrong name is worse
  // than none, and the caller falls back to the plugin name.
  return found.size === 1 ? [...found][0] : null;
}

// The skill namespace is the plugin's own manifest name, which is NOT always the
// enabledPlugins key: vercel is keyed "vercel-plugin@vercel" but ships its skills
// as "vercel:knowledge-update".
function pluginSkillPrefix(root, key) {
  const declared = readJsonFile(path.join(root, ".claude-plugin", "plugin.json"))?.name;
  return typeof declared === "string" && declared ? declared : key.split("@")[0];
}

function readAlwaysOnSkills(settingsPath) {
  try {
    const claudeDir = path.dirname(settingsPath);
    // installed_plugins.json keys on the same "<plugin>@<marketplace>" string as
    // enabledPlugins and gives an exact installPath, which removes all version
    // guessing — the cache can hold several versions of a plugin (superpowers has
    // both 5.1.0 and 6.2.0) while only one is installed.
    const installed = readJsonFile(path.join(claudeDir, "plugins", "installed_plugins.json"))?.plugins;
    if (!installed || typeof installed !== "object") return [];

    const result = [];
    for (const key of readEnabledPlugins(settingsPath)) {
      const root = installed[key]?.[0]?.installPath;
      if (typeof root !== "string" || !root) continue;
      // No SessionStart hook means nothing is injected, so the plugin is not
      // always-on. This is what keeps the list a real subset of enabled_plugins.
      if (!injectsAtSessionStart(root)) continue;
      const skill = inferEntryPointSkill(root);
      result.push({ plugin: key, skill: skill ? `${pluginSkillPrefix(root, key)}:${skill}` : null });
    }
    return result;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

function claudeMdShareLevel(claudeMd) {
  if (claudeMd === "full") return "full";
  if (claudeMd === "redacted") return "redacted";
  return null;
}

// raw must never carry more than the row's own sanitized fields do — otherwise
// it's a side channel that defeats consent-driven redaction/minimization.
function sanitizeRaw(payload, eventName, consent) {
  let sanitized;
  if (eventName === "InstructionsLoaded") {
    sanitized = { ...payload };
    if (consent?.claudeMd !== "full") {
      const redacted = redactClaudeMd(payload?.content ?? payload?.instructions ?? "");
      if ("content" in sanitized) sanitized.content = redacted;
      if ("instructions" in sanitized) sanitized.instructions = redacted;
    }
  } else if (eventName === "PreToolUse") {
    sanitized = { ...payload };
    if (sanitized.tool_input && typeof sanitized.tool_input === "object") {
      // Strict whitelist. `skill` is a public plugin identifier and safe to keep;
      // `args` sits right next to it in the same payload and must NEVER be added
      // here — it carries free-text user content (project briefs, prompts).
      sanitized.tool_input = {
        file_path: sanitized.tool_input.file_path ?? null,
        skill: sanitized.tool_input.skill ?? null,
      };
    }
  } else {
    // SessionStart / SessionEnd / anything else: no content-bearing fields, passthrough (copied).
    sanitized = { ...payload };
  }

  // transcript_path/prompt_id are local filesystem paths (containing the OS
  // username) / session identifiers that leak regardless of any consent choice.
  delete sanitized.transcript_path;
  delete sanitized.prompt_id;
  // permission_mode is part of "activity sharing" consent (see buildRow) — must
  // not survive into raw as a side channel when the user opted out of it.
  if (consent?.activity !== "yes") sanitized.permission_mode = null;

  return sanitized;
}

function buildRow({ eventName, payload, consent, config, settingsPath }) {
  const cwd = payload?.cwd ?? process.cwd();
  const row = {
    session_id: payload?.session_id ?? null,
    user_email: config?.userEmail ?? null,
    hostname: os.hostname(),
    hook_event_name: eventName,
    // permission_mode is gated on activity consent, same as tool/skill/MCP usage —
    // the consent flow presents them as one "activity sharing" choice.
    permission_mode: consent?.activity === "yes" ? (payload?.permission_mode ?? null) : null,
    cwd,
    git_branch: gitBranch(cwd),
    repo_name: consent?.activity === "yes" ? repoName(cwd) : null,
    claude_md_share_level: claudeMdShareLevel(consent?.claudeMd),
    raw: sanitizeRaw(payload, eventName, consent),
    client_ts: new Date().toISOString(),
  };

  if (eventName === "SessionStart") {
    row.installed_hooks = readInstalledHooks(settingsPath);
    row.enabled_plugins = consent?.activity === "yes" ? readEnabledPlugins(settingsPath) : null;
    row.always_on_skills = consent?.activity === "yes" ? readAlwaysOnSkills(settingsPath) : null;
  } else if (eventName === "InstructionsLoaded") {
    const rawContent = readInstructionsContent(payload);
    row.content = consent?.claudeMd === "redacted" ? redactClaudeMd(rawContent) : rawContent;
    row.file_path = payload?.file_path ?? payload?.path ?? "";
    row.load_reason = payload?.load_reason ?? payload?.reason ?? "";
  } else if (eventName === "PreToolUse") {
    row.tool_name = payload?.tool_name ?? null;
    row.file_path = payload?.tool_input?.file_path ?? null;
    // tool_name is always the literal "Skill" for a skill invocation — the skill's
    // own name only exists in tool_input.skill, which is why per-skill usage was
    // unreportable until this column existed.
    row.skill_name = payload?.tool_input?.skill ?? null;
  }
  // SessionEnd: boundary marker — common fields only, no tool_name/content.

  return row;
}

// ---------------------------------------------------------------------------
// Fire-and-forget POST
// ---------------------------------------------------------------------------

// node:https, not fetch(). fetch() leaves undici's connection pool holding the
// event loop after the request settles, which is why this used to end in
// process.exit() — and exiting mid-teardown is what tripped libuv's
// "!(handle->flags & UV_HANDLE_CLOSING)" assertion in async.c on Windows,
// aborting the hook on every single tool call. AbortController is no help
// either: it rejects the promise but leaves a connecting socket open, so an
// unreachable host stalled the hook ~11s. A plain request with agent:false has
// no keep-alive to leak and req.destroy() genuinely cancels, so the loop drains
// on its own and nobody has to call process.exit() at all.
function postEvent(config, row) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    try {
      const body = JSON.stringify(row);
      const url = `${config.supabaseUrl}/rest/v1/claude_events`;
      const req = (url.startsWith("http://") ? http : https).request(
        url,
        {
          method: "POST",
          agent: false,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            apikey: config.supabasePublishableKey,
            Authorization: `Bearer ${config.supabasePublishableKey}`,
            Prefer: "return=minimal",
          },
        },
        (res) => {
          res.resume(); // drain, or the socket never closes
          res.on("end", finish);
        },
      );
      // network failure, non-2xx, malformed URL — no retry, no buffering.
      req.on("error", finish);
      req.on("close", finish);
      timer = setTimeout(() => {
        req.destroy();
        finish();
      }, 1200);
      req.end(body);
    } catch {
      finish();
    }
  });
}

// ---------------------------------------------------------------------------
// Drift check between the copy that runs and the copy in the repo
//
// install.mjs drops a standalone copy at ~/.claude/hooks/glasshouse.mjs and
// that is what actually executes; editing only the repo source changes nothing
// about real telemetry. The two have silently diverged twice already. When a
// session is inside a checkout that carries the source, say so at SessionStart
// instead of letting it rot — see "Two copies of the hook" in CLAUDE.md.
// ---------------------------------------------------------------------------

function samePath(a, b) {
  try {
    // .native normalizes drive-letter and 8.3 casing on Windows
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// Where this checkout keeps the hook source, or "" if cwd isn't in one.
// Uses the git toplevel so it resolves correctly inside a worktree too.
function repoSourcePath(cwd) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (!top) return "";
    const source = path.join(top, "glasshouse-plugin", "glasshouse.mjs");
    return fs.existsSync(source) ? source : "";
  } catch {
    return "";
  }
}

// Compare content, not bytes: a line-ending difference is not real drift. Unreadable
// on either side counts as "same" — not our business to guess.
function filesDiffer(a, b) {
  try {
    const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    return read(a) !== read(b);
  } catch {
    return false;
  }
}

function hookDriftWarning(selfPath, sourcePath) {
  if (!selfPath || !sourcePath) return null;
  if (samePath(selfPath, sourcePath)) return null; // running the repo copy itself

  // install.mjs drops two files now, and glasshouse.sh rots more quietly than the hook
  // it launches: a stale launcher still starts something, so nothing looks wrong.
  const drifted = [];
  if (filesDiffer(selfPath, sourcePath)) drifted.push("glasshouse.mjs");
  const selfSh = path.join(path.dirname(selfPath), "glasshouse.sh");
  const sourceSh = path.join(path.dirname(sourcePath), "glasshouse.sh");
  if (fs.existsSync(selfSh) && fs.existsSync(sourceSh) && filesDiffer(selfSh, sourceSh)) {
    drifted.push("glasshouse.sh");
  }
  if (drifted.length === 0) return null;

  return (
    `Glasshouse hook drift in ${drifted.join(" and ")}: the copy that is actually running differs ` +
    `from this checkout's source. Running "${selfPath}", source "${sourcePath}". Whichever edit is ` +
    `newer is not live everywhere, so diff the two and keep the union rather than overwriting one ` +
    `with the other, then re-run \`node install.mjs\` to sync. Note the installed copy is ` +
    `machine-wide — every session in every repo shares it, so a git worktree does not isolate it.`
  );
}

// ---------------------------------------------------------------------------
// SessionStart notices
// ---------------------------------------------------------------------------

// Cloud sessions run on Anthropic-hosted VMs with no persistent ~/.claude. Asking for an
// email there is worse than useless: the VM discards the answer, so the same prompt
// returns next session, forever. Say what is true instead and ask for nothing.
const CLOUD_SESSION_NOTICE =
  `Glasshouse does not capture from cloud sessions. This one runs on an Anthropic-hosted VM with ` +
  `no persistent ~/.claude, so no email or consent is on file here and nothing is being recorded. ` +
  `The user's local sessions are unaffected. Mention this only if it comes up, and do not ask them ` +
  `for an email address or consent answers in this session — any answer would be discarded when ` +
  `the VM is torn down.`;

// The two docs pages disagree about which variable exists, so check both rather than
// betting on either.
function isRemoteSession(env) {
  return env?.CLAUDE_CODE_REMOTE === "true" || Boolean(env?.CLAUDE_CODE_REMOTE_SESSION_ID);
}

// Pure: everything it needs is a parameter, so selfCheck can assert on the exact text
// without a session, a network, or a temp HOME.
function buildSessionStartNotices({ config, consent, nodeCmd, hookPath, repoKey, driftWarning, isRemote }) {
  if (isRemote) return [CLOUD_SESSION_NOTICE];

  // Drift is reported alongside any consent/email prompt, not instead of it.
  const notices = driftWarning ? [driftWarning] : [];

  // glasshouse.sh sets nodeCmd only when it found the runtime somewhere PATH will not —
  // there, a bare `node` would fail. Left bare and unquoted otherwise, because Claude
  // runs these through PowerShell on Windows, where a quoted string is a value rather
  // than a command to execute.
  const node = nodeCmd === "node" ? "node" : JSON.stringify(nodeCmd);

  if (!config) {
    notices.push(
      `Glasshouse usage analytics has no email on file yet (this is asked once, globally, ` +
        `not per-repo). Ask the user for the email address they want associated with Glasshouse ` +
        `data, then run: ${node} "${hookPath}" set-email --email "<email>". ` +
        `Nothing is sent anywhere until that command runs. ` +
        `This email will be shown on Glasshouse's public directory page and used in your profile's URL.`,
    );
  } else if (!consent) {
    notices.push(
      `Glasshouse usage analytics has no sharing preference on file for this repo yet. ` +
        `Ask the user via AskUserQuestion, exactly two questions: ` +
        `(1) CLAUDE.md sharing — none / redacted (default, recommended) / full; ` +
        `(2) Activity sharing (tool/skill/MCP usage + permission-mode timing + repo name) — yes / no. ` +
        `Then run: ${node} "${hookPath}" consent --repo "${repoKey}" --claude-md <none|redacted|full> --activity <yes|no>. ` +
        `Nothing is sent for this repo until that command runs.`,
    );
  }

  return notices;
}

// ---------------------------------------------------------------------------
// Hook mode
// ---------------------------------------------------------------------------

async function sendIfConsented(eventName, payload, consent, homeDir, settingsPath) {
  const config = loadConfig(homeDir);
  if (!config) return;
  const row = buildRow({ eventName, payload, consent, config, settingsPath });
  await postEvent(config, row);
}

// Ends by simply returning — no forced exit, deliberately. Tearing the process
// down while the HTTP socket was still closing is what aborted this hook on
// Windows (see postEvent). Everything below is either synchronous or bounded by
// postEvent's 1200ms timeout, so the event loop drains on its own. selfCheck
// asserts this function never regains a forced exit.
async function runHookMode() {
  try {
    let payload = {};
    try {
      payload = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch {
      payload = {};
    }
    if (!payload || typeof payload !== "object") payload = {};

    const homeDir = os.homedir();
    const settingsPath = path.join(homeDir, ".claude", "settings.json");
    const eventName = payload?.hook_event_name;
    const cwd = payload?.cwd ?? process.cwd();
    const repoKey = computeRepoKey(cwd);
    const consent = loadConsentStore(homeDir)[repoKey];

    if (eventName === "SessionStart") {
      const config = loadConfig(homeDir);
      const isRemote = isRemoteSession(process.env);
      const notices = buildSessionStartNotices({
        config,
        consent,
        nodeCmd: process.env.GLASSHOUSE_NODE || "node",
        hookPath: String(process.argv[1] ?? "").split(path.sep).join("/"),
        repoKey,
        // A cloud session is not a checkout anyone is developing in; drift there is
        // noise on top of a notice that already says nothing is being captured.
        driftWarning: isRemote
          ? null
          : hookDriftWarning(fileURLToPath(import.meta.url), repoSourcePath(cwd)),
        isRemote,
      });

      if (config && consent && consent.activity === "yes") {
        await sendIfConsented(eventName, payload, consent, homeDir, settingsPath);
      }

      const text = notices.filter(Boolean).join("\n\n");
      if (text) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
          }) + "\n",
        );
      }
    } else if (eventName === "InstructionsLoaded") {
      if (consent && consent.claudeMd !== "none") {
        await sendIfConsented(eventName, payload, consent, homeDir, settingsPath);
      }
    } else if (eventName === "PreToolUse") {
      if (consent && consent.activity === "yes") {
        await sendIfConsented(eventName, payload, consent, homeDir, settingsPath);
      }
    } else if (eventName === "SessionEnd") {
      if (consent && consent.activity === "yes") {
        await sendIfConsented(eventName, payload, consent, homeDir, settingsPath);
      }
    }
    // any other event: no-op
  } catch {
    // a hook must never crash a real session
  }
}

// ---------------------------------------------------------------------------
// Consent CLI
// ---------------------------------------------------------------------------

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return flags;
}

function runConsentMode(argv) {
  const flags = parseFlags(argv);
  const repo = flags.repo;
  const claudeMd = flags["claude-md"];
  const activity = flags.activity;

  const validClaudeMd = ["none", "redacted", "full"];
  const validActivity = ["yes", "no"];

  if (!repo || !validClaudeMd.includes(claudeMd) || !validActivity.includes(activity)) {
    process.stderr.write(
      'Usage: glasshouse.mjs consent --repo "<key>" --claude-md <none|redacted|full> --activity <yes|no>\n',
    );
    process.exit(1);
    return;
  }

  const homeDir = os.homedir();
  const store = loadConsentStore(homeDir);
  store[repo] = { claudeMd, activity, updatedAt: new Date().toISOString() };
  saveConsentStore(homeDir, store);
  process.exit(0);
}

function runSetEmailMode(argv) {
  const flags = parseFlags(argv);
  const email = flags.email;
  if (!email) {
    process.stderr.write('Usage: glasshouse.mjs set-email --email "<email>"\n');
    process.exit(1);
    return;
  }
  saveConfig(os.homedir(), { userEmail: email });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-check — assert-based, no network calls, no real files touched.
// ---------------------------------------------------------------------------

async function selfCheck() {
  // redactClaudeMd: keeps headings only, appends exact omitted-count line.
  const content = "# Title\nSome body text\n## Sub\nMore text here";
  const expected = [
    "# Title",
    "## Sub",
    `[glasshouse: body redacted — ${content.split("\n").length} lines / ${content.length} chars omitted]`,
  ].join("\n");
  assert.strictEqual(redactClaudeMd(content), expected);

  // readInstructionsContent: inline payload.content/instructions wins; else
  // reads file_path from disk; missing/unreadable file falls back to "".
  assert.strictEqual(readInstructionsContent({ content: "inline text" }), "inline text");
  assert.strictEqual(readInstructionsContent({ instructions: "inline alt" }), "inline alt");
  const tmpFile = path.join(os.tmpdir(), `glasshouse-selfcheck-${process.pid}.md`);
  try {
    fs.writeFileSync(tmpFile, "# From disk\nbody");
    assert.strictEqual(readInstructionsContent({ file_path: tmpFile }), "# From disk\nbody");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  assert.strictEqual(readInstructionsContent({ file_path: path.join(os.tmpdir(), "glasshouse-selfcheck-missing.md") }), "");
  assert.strictEqual(readInstructionsContent({}), "");

  // computeRepoKey: falls back to path.resolve(cwd) for a dir with no git remote.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-selfcheck-"));
  try {
    assert.strictEqual(computeRepoKey(tmpDir), path.resolve(tmpDir));

    // repoName itself (pure function, no consent involved) — path fallback.
    assert.strictEqual(repoName(tmpDir), path.basename(tmpDir));
    // + a second case in a throwaway git repo with a fake origin remote,
    // asserting repoName strips ".git" and takes the last URL segment
    // (e.g. git@github.com:someorg/glasshouse.git -> "glasshouse")
    const fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-fakerepo-"));
    try {
      execFileSync("git", ["init"], { cwd: fakeRepoDir, stdio: "ignore" });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:someorg/glasshouse.git"], {
        cwd: fakeRepoDir,
        stdio: "ignore",
      });
      assert.strictEqual(repoName(fakeRepoDir), "glasshouse");
    } finally {
      fs.rmSync(fakeRepoDir, { recursive: true, force: true });
    }

    // row.repo_name is gated on activity consent, same as permission_mode/enabled_plugins.
    const activityYesRow = buildRow({
      eventName: "SessionStart", payload: { cwd: tmpDir },
      consent: { claudeMd: "none", activity: "yes" }, config: {},
      settingsPath: path.join(os.tmpdir(), "does-not-exist.json"),
    });
    assert.strictEqual(activityYesRow.repo_name, path.basename(tmpDir));
    const activityNoRow = buildRow({
      eventName: "SessionStart", payload: { cwd: tmpDir },
      consent: { claudeMd: "none", activity: "no" }, config: {},
      settingsPath: path.join(os.tmpdir(), "does-not-exist.json"),
    });
    assert.strictEqual(activityNoRow.repo_name, null);

    // loadConsentStore/loadConfig: missing file never throws.
    assert.deepStrictEqual(loadConsentStore(tmpDir), {});
    assert.strictEqual(loadConfig(tmpDir), null);

    // loadConfig/saveConfig: embedded Supabase constants fill in when
    // config.json only has userEmail; an explicit supabaseUrl/
    // supabasePublishableKey (local-dev override) still wins.
    saveConfig(tmpDir, { userEmail: "a@example.com" });
    assert.deepStrictEqual(loadConfig(tmpDir), {
      supabaseUrl: SUPABASE_URL,
      supabasePublishableKey: SUPABASE_PUBLISHABLE_KEY,
      userEmail: "a@example.com",
    });
    saveConfig(tmpDir, {
      userEmail: "b@example.com",
      supabaseUrl: "https://test.local",
      supabasePublishableKey: "pk_test",
    });
    assert.deepStrictEqual(loadConfig(tmpDir), {
      supabaseUrl: "https://test.local",
      supabasePublishableKey: "pk_test",
      userEmail: "b@example.com",
    });

    // readInstalledHooks: fixture returns matchers only, never command strings.
    const settingsPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: "node C:/secret/block.mjs" }] },
          ],
          SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "node C:/secret/glasshouse.mjs" }] }],
        },
      }),
    );
    const installed = readInstalledHooks(settingsPath);
    assert.deepStrictEqual(installed, { PreToolUse: ["Bash|PowerShell"], SessionStart: ["*"] });
    assert.strictEqual(JSON.stringify(installed).includes("secret"), false);
    assert.deepStrictEqual(readInstalledHooks(path.join(tmpDir, "missing.json")), {});
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // claude_md_share_level mapping for all three consent values.
  assert.strictEqual(claudeMdShareLevel("full"), "full");
  assert.strictEqual(claudeMdShareLevel("redacted"), "redacted");
  assert.strictEqual(claudeMdShareLevel("none"), null);

  // raw must not be a side channel around redaction: InstructionsLoaded + "redacted"
  // consent must not leak the un-redacted body via row.raw.content.
  const bodyText = "this is proprietary body text that must never leave the machine";
  const instructionsRow = buildRow({
    eventName: "InstructionsLoaded",
    payload: { content: `# Heading\n${bodyText}`, cwd: "/tmp/x" },
    consent: { claudeMd: "redacted", activity: "no" },
    config: {},
    settingsPath: path.join(os.tmpdir(), "does-not-exist.json"),
  });
  assert.strictEqual(instructionsRow.raw.content.includes(bodyText), false);
  assert.strictEqual(instructionsRow.raw.content, instructionsRow.content);

  // PreToolUse: raw.tool_input must be stripped to file_path only.
  const preToolRow = buildRow({
    eventName: "PreToolUse",
    payload: {
      cwd: "/tmp/x",
      tool_name: "Write",
      tool_input: { file_path: "/tmp/x/secret.txt", content: "top secret file contents" },
    },
    consent: { claudeMd: "none", activity: "yes" },
    config: {},
    settingsPath: path.join(os.tmpdir(), "does-not-exist.json"),
  });
  assert.deepStrictEqual(Object.keys(preToolRow.raw.tool_input), ["file_path", "skill"]);
  assert.strictEqual(preToolRow.skill_name, null); // not a Skill call
  assert.strictEqual("content" in preToolRow.raw.tool_input, false);

  // Skill invocations: the name must survive to row.skill_name (tool_name is
  // only ever the literal "Skill"), and `args` must not survive anywhere — it is
  // free-text user content. This is the assertion that fails if the tool_input
  // whitelist above is ever widened carelessly.
  const secretArgs = "confidential client brief that must never leave the machine";
  const skillRow = buildRow({
    eventName: "PreToolUse",
    payload: {
      cwd: "/tmp/x",
      tool_name: "Skill",
      tool_input: { skill: "superpowers:brainstorming", args: secretArgs },
    },
    consent: { claudeMd: "none", activity: "yes" },
    config: {},
    settingsPath: path.join(os.tmpdir(), "does-not-exist.json"),
  });
  assert.strictEqual(skillRow.tool_name, "Skill");
  assert.strictEqual(skillRow.skill_name, "superpowers:brainstorming");
  assert.strictEqual(JSON.stringify(skillRow).includes(secretArgs), false);

  // enabled_plugins: only entries explicitly true, and gated on activity consent.
  const pluginSettings = path.join(os.tmpdir(), `glasshouse-plugins-${process.pid}.json`);
  try {
    fs.writeFileSync(
      pluginSettings,
      JSON.stringify({ enabledPlugins: { "ponytail@ponytail": true, "off@marketplace": false } }),
    );
    assert.deepStrictEqual(readEnabledPlugins(pluginSettings), ["ponytail@ponytail"]);
    const args = { eventName: "SessionStart", payload: { cwd: "/tmp/x" }, config: {}, settingsPath: pluginSettings };
    assert.deepStrictEqual(
      buildRow({ ...args, consent: { claudeMd: "none", activity: "yes" } }).enabled_plugins,
      ["ponytail@ponytail"],
    );
    assert.strictEqual(
      buildRow({ ...args, consent: { claudeMd: "none", activity: "no" } }).enabled_plugins,
      null,
    );
  } finally {
    fs.rmSync(pluginSettings, { force: true });
  }
  assert.deepStrictEqual(readEnabledPlugins(path.join(os.tmpdir(), "glasshouse-no-such.json")), []);

  // always_on_skills: only enabled plugins that actually register a SessionStart
  // hook, with the entry-point skill inferred from their hook scripts. The fixture
  // covers all four shapes seen in the wild plus both skip paths.
  const alwaysOnHome = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-alwayson-"));
  try {
    const write = (content, ...segs) => {
      const file = path.join(alwaysOnHome, ...segs);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    const skillDir = (...segs) => fs.mkdirSync(path.join(alwaysOnHome, ...segs), { recursive: true });

    // alpha: hooks file declared via the manifest's "hooks" key (ponytail's shape),
    // slash-separated path, and a manifest "name" that differs from the
    // enabledPlugins key (vercel's shape — keyed vercel-plugin@vercel, ships
    // vercel:*). The prefix must come from the manifest, not the key.
    write(
      JSON.stringify({ name: "alpha-named", hooks: "./hooks/mine.json" }),
      "alpha", ".claude-plugin", "plugin.json",
    );
    write(JSON.stringify({ hooks: { SessionStart: [{}] } }), "alpha", "hooks", "mine.json");
    write('cat "$ROOT/skills/entry/SKILL.md"', "alpha", "hooks", "boot.sh");
    skillDir("alpha", "skills", "entry");
    // A skill named far more often than the injected one must not win — this is
    // what the discarded frequency heuristic got wrong on vercel.
    write("noisy noisy noisy noisy noisy", "alpha", "hooks", "ranker.js");
    skillDir("alpha", "skills", "noisy");

    // beta: no manifest at all — hooks must be found via the conventional
    // hooks/hooks.json (superpowers' shape), the name only appears split across
    // path.join arguments, and the prefix falls back to the key.
    write(JSON.stringify({ hooks: { SessionStart: [{}] } }), "beta", "hooks", "hooks.json");
    write("path.join('..','skills','main','SKILL.md')", "beta", "hooks", "activate.js");
    skillDir("beta", "skills", "main");
    skillDir("beta", "skills", "aux");

    // delta: injects at SessionStart but reads two different SKILL.md files, so no
    // single name is safe — must report the plugin with a null skill, not a guess.
    write(JSON.stringify({ hooks: { SessionStart: [{}] } }), "delta", "hooks", "hooks.json");
    write("skills/one/SKILL.md and skills/two/SKILL.md", "delta", "hooks", "boot.sh");
    skillDir("delta", "skills", "one");
    skillDir("delta", "skills", "two");

    // gamma: has hooks, but nothing on SessionStart — not always-on at all.
    write(JSON.stringify({ hooks: { PreToolUse: [{}] } }), "gamma", "hooks", "hooks.json");
    skillDir("gamma", "skills", "thing");

    write(
      JSON.stringify({
        enabledPlugins: {
          "alpha@mk": true,
          "beta@mk": true,
          "delta@mk": true,
          "gamma@mk": true,
          "nocache@mk": true,
          "off@mk": false,
        },
      }),
      "settings.json",
    );
    write(
      JSON.stringify({
        plugins: {
          "alpha@mk": [{ installPath: path.join(alwaysOnHome, "alpha") }],
          "beta@mk": [{ installPath: path.join(alwaysOnHome, "beta") }],
          "delta@mk": [{ installPath: path.join(alwaysOnHome, "delta") }],
          "gamma@mk": [{ installPath: path.join(alwaysOnHome, "gamma") }],
        },
      }),
      "plugins",
      "installed_plugins.json",
    );

    // gamma is dropped (no SessionStart), nocache is dropped (no installPath),
    // off is never enabled — so this is a strict subset of enabled_plugins.
    const alwaysOnSettings = path.join(alwaysOnHome, "settings.json");
    assert.deepStrictEqual(readAlwaysOnSkills(alwaysOnSettings), [
      { plugin: "alpha@mk", skill: "alpha-named:entry" },
      { plugin: "beta@mk", skill: "beta:main" },
      { plugin: "delta@mk", skill: null },
    ]);
    // A skill directory no hook ever reads must not be reported at all.
    assert.strictEqual(JSON.stringify(readAlwaysOnSkills(alwaysOnSettings)).includes("noisy"), false);

    // installPath is absolute and carries the OS username — it must never survive
    // into the row, only the plugin/skill names derived from it.
    assert.strictEqual(JSON.stringify(readAlwaysOnSkills(alwaysOnSettings)).includes(alwaysOnHome), false);

    const alwaysOnArgs = {
      eventName: "SessionStart",
      payload: { cwd: "/tmp/x" },
      config: {},
      settingsPath: alwaysOnSettings,
    };
    assert.strictEqual(
      buildRow({ ...alwaysOnArgs, consent: { claudeMd: "none", activity: "yes" } }).always_on_skills.length,
      3,
    );
    assert.strictEqual(
      buildRow({ ...alwaysOnArgs, consent: { claudeMd: "none", activity: "no" } }).always_on_skills,
      null,
    );
  } finally {
    fs.rmSync(alwaysOnHome, { recursive: true, force: true });
  }
  // A missing settings.json / installed_plugins.json must degrade to [], never throw:
  // this runs on every session start on other people's machines.
  assert.deepStrictEqual(readAlwaysOnSkills(path.join(os.tmpdir(), "glasshouse-no-such.json")), []);

  // permission_mode is gated on activity consent ("activity sharing" covers both
  // tool/skill/MCP usage AND permission-mode timing) — activity !== "yes" must
  // null it out in row.permission_mode AND in row.raw (no side-channel leak).
  const noActivityRow = buildRow({
    eventName: "SessionStart",
    payload: { cwd: "/tmp/x", permission_mode: "plan" },
    consent: { claudeMd: "none", activity: "no" },
    config: {},
    settingsPath: path.join(os.tmpdir(), "does-not-exist.json"),
  });
  assert.strictEqual(noActivityRow.permission_mode, null);
  assert.strictEqual(noActivityRow.raw.permission_mode, null);

  // transcript_path/prompt_id (local filesystem paths / identifiers) must never
  // survive into raw, on every sanitizeRaw branch.
  for (const eventName of ["SessionStart", "SessionEnd", "InstructionsLoaded", "PreToolUse"]) {
    const leakRow = buildRow({
      eventName,
      payload: {
        cwd: "/tmp/x",
        transcript_path: "C:/Users/thor/.claude/transcript.jsonl",
        prompt_id: "prompt-123",
        content: "# H\nbody",
        tool_input: { file_path: "/tmp/x/f.txt" },
      },
      consent: { claudeMd: "full", activity: "yes" },
      config: {},
      settingsPath: path.join(os.tmpdir(), "does-not-exist.json"),
    });
    assert.strictEqual("transcript_path" in leakRow.raw, false);
    assert.strictEqual("prompt_id" in leakRow.raw, false);
  }

  // hookDriftWarning: only fires on a real content difference between the copy
  // that runs and the repo source, and never on line endings alone.
  const driftDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-drift-"));
  try {
    const installed = path.join(driftDir, "installed.mjs");
    const source = path.join(driftDir, "source.mjs");

    fs.writeFileSync(installed, "const a = 1;\nconst b = 2;\n");
    fs.writeFileSync(source, "const a = 1;\nconst b = 2;\n");
    assert.strictEqual(hookDriftWarning(installed, source), null, "identical copies must not warn");

    // CRLF vs LF is not drift.
    fs.writeFileSync(source, "const a = 1;\r\nconst b = 2;\r\n");
    assert.strictEqual(hookDriftWarning(installed, source), null, "line endings alone must not warn");

    // A real difference must warn, and must name both paths so it is actionable.
    fs.writeFileSync(source, "const a = 1;\nconst b = 3;\n");
    const warning = hookDriftWarning(installed, source);
    assert.ok(warning && warning.includes(installed) && warning.includes(source), "drift must name both paths");

    // Running the repo copy directly is not drift, and neither is a missing side.
    assert.strictEqual(hookDriftWarning(source, source), null, "same file must not warn");
    assert.strictEqual(hookDriftWarning(installed, ""), null, "no repo source means nothing to compare");
    assert.strictEqual(hookDriftWarning(installed, path.join(driftDir, "gone.mjs")), null, "missing source must not warn");
  } finally {
    fs.rmSync(driftDir, { recursive: true, force: true });
  }

  // The launcher drifts too, and on its own: glasshouse.mjs can be byte-identical while
  // the glasshouse.sh beside it is stale. Needs two directories, since the check reads
  // each side's sibling.
  const shSelfDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-drift-self-"));
  const shSrcDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-drift-src-"));
  try {
    const selfMjs = path.join(shSelfDir, "glasshouse.mjs");
    const srcMjs = path.join(shSrcDir, "glasshouse.mjs");
    fs.writeFileSync(selfMjs, "same\n");
    fs.writeFileSync(srcMjs, "same\n");
    assert.strictEqual(hookDriftWarning(selfMjs, srcMjs), null, "identical .mjs, no .sh present, must not warn");

    fs.writeFileSync(path.join(shSelfDir, "glasshouse.sh"), "echo one\n");
    assert.strictEqual(
      hookDriftWarning(selfMjs, srcMjs),
      null,
      "a .sh on only one side is not drift — nothing to compare it against",
    );

    fs.writeFileSync(path.join(shSrcDir, "glasshouse.sh"), "echo two\n");
    const shWarning = hookDriftWarning(selfMjs, srcMjs);
    assert.ok(
      shWarning && shWarning.includes("glasshouse.sh") && !shWarning.includes("glasshouse.mjs and"),
      "a wrapper-only difference must warn, and name only the wrapper",
    );

    fs.writeFileSync(path.join(shSrcDir, "glasshouse.sh"), "echo one\r\n");
    assert.strictEqual(hookDriftWarning(selfMjs, srcMjs), null, "wrapper line endings alone must not warn");

    // Both files stale at once names both, so the fix instruction covers both.
    fs.writeFileSync(srcMjs, "different\n");
    fs.writeFileSync(path.join(shSrcDir, "glasshouse.sh"), "echo two\n");
    const bothWarning = hookDriftWarning(selfMjs, srcMjs);
    assert.ok(
      bothWarning && bothWarning.includes("glasshouse.mjs and glasshouse.sh"),
      "drift in both files must name both",
    );
  } finally {
    fs.rmSync(shSelfDir, { recursive: true, force: true });
    fs.rmSync(shSrcDir, { recursive: true, force: true });
  }

  // isRemoteSession: either variable is enough, and neither being set is local.
  assert.strictEqual(isRemoteSession({ CLAUDE_CODE_REMOTE: "true" }), true);
  assert.strictEqual(isRemoteSession({ CLAUDE_CODE_REMOTE_SESSION_ID: "session_abc" }), true);
  assert.strictEqual(isRemoteSession({}), false);
  assert.strictEqual(isRemoteSession({ CLAUDE_CODE_REMOTE: "false" }), false);

  // Cloud sessions: exactly one notice, and none of the prompts. Asking for an email on
  // a VM that discards the answer re-asks forever, which is the whole point of this
  // branch — so assert the prompts are absent, not merely that something was returned.
  const remoteNotices = buildSessionStartNotices({
    config: null,
    consent: undefined,
    nodeCmd: "node",
    hookPath: "/x/glasshouse.mjs",
    repoKey: "git@github.com:o/r",
    driftWarning: "drift happened",
    isRemote: true,
  });
  assert.deepStrictEqual(remoteNotices, [CLOUD_SESSION_NOTICE]);
  assert.strictEqual(remoteNotices.join("").includes("set-email"), false);
  assert.strictEqual(remoteNotices.join("").includes("AskUserQuestion"), false);
  assert.strictEqual(remoteNotices.join("").includes("drift happened"), false);

  // Local, no config: the email prompt, preceded by any drift warning.
  const emailNotices = buildSessionStartNotices({
    config: null,
    consent: undefined,
    nodeCmd: "node",
    hookPath: "/x/glasshouse.mjs",
    repoKey: "git@github.com:o/r",
    driftWarning: "drift happened",
    isRemote: false,
  });
  assert.strictEqual(emailNotices.length, 2);
  assert.strictEqual(emailNotices[0], "drift happened");
  assert.ok(emailNotices[1].includes("set-email"));

  // Local, config but no consent: the two-question prompt, carrying the repo key.
  const consentNotices = buildSessionStartNotices({
    config: { userEmail: "a@example.com" },
    consent: undefined,
    nodeCmd: "node",
    hookPath: "/x/glasshouse.mjs",
    repoKey: "git@github.com:o/r",
    driftWarning: null,
    isRemote: false,
  });
  assert.strictEqual(consentNotices.length, 1);
  assert.ok(consentNotices[0].includes("consent --repo \"git@github.com:o/r\""));

  // Fully configured and consented: nothing to say.
  assert.deepStrictEqual(
    buildSessionStartNotices({
      config: { userEmail: "a@example.com" },
      consent: { claudeMd: "none", activity: "yes" },
      nodeCmd: "node",
      hookPath: "/x/glasshouse.mjs",
      repoKey: "k",
      driftWarning: null,
      isRemote: false,
    }),
    [],
  );

  // The interpreter glasshouse.sh resolved must be the one Claude is told to run — a bare
  // `node` fails from the Bash tool whenever the launcher had to look off PATH, which is
  // exactly the nvm/fnm/volta case the launcher exists to handle. But the default stays
  // unquoted: Claude runs these commands through PowerShell on Windows, where "node" is
  // a string literal rather than a command, so quoting it universally would break the
  // majority case to serve the minority one.
  const resolvedNode = "/home/u/.nvm/versions/node/v22.13.1/bin/node";
  for (const [nodeCmd, expected] of [
    ["node", `node "/x/glasshouse.mjs"`],
    [resolvedNode, `"${resolvedNode}" "/x/glasshouse.mjs"`],
  ]) {
    for (const config of [null, { userEmail: "a@example.com" }]) {
      const [notice] = buildSessionStartNotices({
        config,
        consent: undefined,
        nodeCmd,
        hookPath: "/x/glasshouse.mjs",
        repoKey: "k",
        driftWarning: null,
        isRemote: false,
      });
      assert.ok(notice.includes(expected), `notice must invoke ${expected}, got: ${notice}`);
    }
  }

  // The Windows libuv abort ("!(handle->flags & UV_HANDLE_CLOSING)") that used
  // to fire on every tool call cannot be reproduced offline — it needs a real
  // remote socket. Loopback servers that answer instantly, answer slowly, or
  // never answer all pass even against the old fetch()+process.exit() code, so
  // no self-contained test catches it. Assert the invariant itself instead.
  const noForcedExit = "must not force a process exit — it is what tripped the libuv abort on Windows";
  assert.ok(!runHookMode.toString().includes("process.exit"), `runHookMode ${noForcedExit}`);
  assert.ok(!postEvent.toString().includes("process.exit"), `postEvent ${noForcedExit}`);
  // fetch()'s connection pool outlives the request, which is the only reason a
  // forced exit ever seemed necessary. Keep postEvent on node:http/https.
  assert.ok(!postEvent.toString().includes("fetch("), "postEvent must not use fetch() — see its comment");

  await assertHookModePostsAndExits();
  assertLauncherHandlesMissingNode();

  console.log("OK");
}

// End-to-end smoke test of hook mode: spawns the real thing with a piped stdin
// (how Claude Code invokes it) against a loopback server, with HOME redirected
// at a temp dir so the user's own consent/config are never read. Covers "runs,
// honours consent, posts exactly one row, exits 0" — NOT the libuv abort above,
// which loopback cannot trigger. Loopback only — no outbound network.
function assertHookModePostsAndExits() {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-exitcheck-"));
    let received = 0;

    const server = http.createServer((req, res) => {
      received++;
      req.resume();
      res.writeHead(201).end();
    });

    const cleanup = () => {
      server.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    };

    server.listen(0, "127.0.0.1", () => {
      const dir = glasshouseDir(tmpDir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        configPath(tmpDir),
        JSON.stringify({
          supabaseUrl: `http://127.0.0.1:${server.address().port}`,
          supabasePublishableKey: "selfcheck-key",
          userEmail: "selfcheck@example.invalid",
        }),
      );
      fs.writeFileSync(
        consentPath(tmpDir),
        JSON.stringify({ [path.resolve(tmpDir)]: { claudeMd: "none", activity: "yes" } }),
      );

      const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
        stdio: ["pipe", "pipe", "pipe"], // piped stdin is load-bearing — a file never reproduced it
        env: { ...process.env, HOME: tmpDir, USERPROFILE: tmpDir },
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.resume();
      const killer = setTimeout(() => child.kill(), 20000);

      child.on("close", (code) => {
        clearTimeout(killer);
        cleanup();
        try {
          assert.strictEqual(
            code,
            0,
            `hook mode must exit 0, got ${code}. stderr: ${stderr.trim() || "(empty)"}`,
          );
          assert.strictEqual(received, 1, `hook mode should have posted exactly 1 row, got ${received}`);
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      child.stdin.end(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          cwd: tmpDir,
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
        }),
      );
    });
  });
}

// glasshouse.sh is the hook's real entry point, and its whole reason to exist is the
// machine this test cannot be run on: one with no Node at all. GLASSHOUSE_ASSUME_NO_NODE
// stands in for that machine. Skipped where there is no POSIX shell to run it with
// (native Windows without Git for Windows), which is also where the launcher itself
// cannot run — see docs/installing_glasshouse.md.
function assertLauncherHandlesMissingNode() {
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), "glasshouse.sh");
  if (!fs.existsSync(launcher)) {
    throw new Error(`glasshouse.sh is missing next to glasshouse.mjs — the hook cannot start`);
  }
  if (spawnSync("sh", ["-c", "exit 0"]).status !== 0) return; // no POSIX shell here

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-launcher-"));
  try {
    const run = (payload, home) =>
      spawnSync("sh", [launcher], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, GLASSHOUSE_ASSUME_NO_NODE: "1", HOME: home, USERPROFILE: home },
      });

    // SessionStart: exit 0, explain once, and remember that it explained.
    const sessionHome = path.join(tmpDir, "session");
    const first = run({ hook_event_name: "SessionStart", cwd: tmpDir }, sessionHome);
    assert.strictEqual(first.status, 0, `launcher must exit 0 without node, got ${first.status}`);
    const notice = JSON.parse(first.stdout);
    assert.strictEqual(notice.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(
      notice.hookSpecificOutput.additionalContext.includes("Node.js"),
      "the no-node notice must name what is missing",
    );
    assert.ok(fs.existsSync(path.join(sessionHome, ".claude", "glasshouse", "node-missing-notified")));

    // Second session: the marker suppresses it. Someone who has decided against
    // installing Node should not be told again every session.
    const second = run({ hook_event_name: "SessionStart", cwd: tmpDir }, sessionHome);
    assert.strictEqual(second.status, 0);
    assert.strictEqual(second.stdout.trim(), "", "the no-node notice must appear only once");

    // Every other event: silent, and no marker — so a PreToolUse can never consume the
    // one notice a SessionStart is owed.
    const toolHome = path.join(tmpDir, "tool");
    const tool = run({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd: tmpDir }, toolHome);
    assert.strictEqual(tool.status, 0, "a missing node must never fail a tool call");
    assert.strictEqual(tool.stdout.trim(), "", "no output on non-SessionStart events");
    assert.strictEqual(fs.existsSync(path.join(toolHome, ".claude")), false);

    // Hand-off. The fake node reports the script it was given and whether the launcher
    // exported an interpreter override, which is what buildSessionStartNotices spends.
    const writeFakeNode = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      const fake = path.join(dir, "node");
      fs.writeFileSync(fake, '#!/bin/sh\nprintf "%s|%s" "$1" "${GLASSHOUSE_NODE:-}"\n');
      fs.chmodSync(fake, 0o755);
      return fake;
    };
    const handOff = (env) => {
      const r = spawnSync("sh", [launcher], { input: "{}", encoding: "utf8", env });
      const [scriptArg, exported] = r.stdout.split("|");
      assert.ok(scriptArg.endsWith("glasshouse.mjs"), `launcher must run glasshouse.mjs, got ${scriptArg}`);
      return exported;
    };

    // Found on PATH: no override. A bare `node` already works from any shell, and an
    // absolute quoted path would not be a runnable command in PowerShell — which is what
    // Claude uses on Windows, where node is always on PATH when it is installed at all.
    const pathBin = writeFakeNode(path.join(tmpDir, "onpath"));
    assert.strictEqual(
      handOff({ ...process.env, PATH: `${path.dirname(pathBin)}${path.delimiter}${process.env.PATH}` }),
      "",
      "a node already on PATH must not be overridden",
    );

    // Found off PATH — the nvm/fnm/volta case this launcher exists for. Here the notices
    // must name the absolute path, or the command Claude runs fails with the same
    // `node: command not found` the launcher just worked around. VOLTA_HOME drives one
    // of the real search locations. PATH keeps everything except the directories that
    // actually hold a node — emptying it outright would leave the shell itself unfindable
    // and prove nothing.
    const pathWithoutNode = (process.env.PATH || "")
      .split(path.delimiter)
      .filter((dir) => dir && !["node", "node.exe"].some((n) => fs.existsSync(path.join(dir, n))))
      .join(path.delimiter);
    const voltaHome = path.join(tmpDir, "volta");
    const voltaNode = writeFakeNode(path.join(voltaHome, "bin"));
    // Slashes normalised: the launcher composes "$VOLTA_HOME/bin/node" with forward
    // slashes while path.join uses the platform separator. Same file either way.
    const slashes = (p) => p.split("\\").join("/");
    assert.strictEqual(
      slashes(handOff({ ...process.env, PATH: pathWithoutNode, VOLTA_HOME: voltaHome })),
      slashes(voltaNode),
      "a node found off PATH must be exported for the notices to name",
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const mode = process.argv[2];

if (mode === "--self-check") {
  selfCheck();
} else if (mode === "consent") {
  runConsentMode(process.argv.slice(3));
} else if (mode === "set-email") {
  runSetEmailMode(process.argv.slice(3));
} else {
  runHookMode();
}
