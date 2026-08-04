#!/usr/bin/env node
// Glasshouse hook dispatcher + consent CLI. Node built-ins only, zero deps.
//
// Invocation shapes (dispatched on process.argv):
//   node glasshouse.mjs                → hook mode (reads a Claude Code hook payload from stdin)
//   node glasshouse.mjs consent ...    → consent CLI (writes ~/.claude/glasshouse/consent.json)
//   node glasshouse.mjs set-email ...  → writes ~/.claude/glasshouse/config.json
//   node glasshouse.mjs --self-check   → offline self-check, never touches real files/network
//
// Ships as the Claude Code plugin's hook script (${CLAUDE_PLUGIN_ROOT}/glasshouse.mjs)
// and is also usable standalone via install.mjs for local development.
// See PLAN.md at the repo root for the full design this implements.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import http from "node:http";
import https from "node:https";
import { execFileSync, spawn } from "node:child_process";
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

// Always-on skills never show up as Skill tool calls: plugins like superpowers
// and ponytail inject their skill text via a SessionStart hook, and plugin hooks
// live in the plugin's own manifest, not in settings.json's "hooks" block — so
// readInstalledHooks cannot see them either. The enabled-plugin set is the only
// local signal that those skills were active. Names only (public marketplace
// identifiers like "ponytail@ponytail"); no paths, no versions.
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

function hookDriftWarning(selfPath, sourcePath) {
  if (!selfPath || !sourcePath) return null;
  if (samePath(selfPath, sourcePath)) return null; // running the repo copy itself
  try {
    // Compare content, not bytes: a line-ending difference is not real drift.
    const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
    if (read(selfPath) === read(sourcePath)) return null;
  } catch {
    return null; // unreadable either side — not our business to guess
  }
  return (
    `Glasshouse hook drift: the copy that is actually running differs from this checkout's source. ` +
    `Running "${selfPath}", source "${sourcePath}". Whichever edit is newer is not live everywhere, ` +
    `so diff the two and keep the union rather than overwriting one with the other, then re-run ` +
    `\`node install.mjs\` to sync. Note the installed copy is machine-wide — every session in every ` +
    `repo shares it, so a git worktree does not isolate it.`
  );
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
      const hookPath = String(process.argv[1] ?? "").split(path.sep).join("/");
      // Drift is reported alongside any consent/email prompt, not instead of it.
      const notices = [hookDriftWarning(fileURLToPath(import.meta.url), repoSourcePath(cwd))];

      if (!config) {
        notices.push(
          `Glasshouse usage analytics has no email on file yet (this is asked once, globally, ` +
            `not per-repo). Ask the user for the email address they want associated with Glasshouse ` +
            `data, then run: node "${hookPath}" set-email --email "<email>". ` +
            `Nothing is sent anywhere until that command runs. ` +
            `This email will be shown on Glasshouse's public directory page and used in your profile's URL.`,
        );
      } else if (!consent) {
        notices.push(
          `Glasshouse usage analytics has no sharing preference on file for this repo yet. ` +
            `Ask the user via AskUserQuestion, exactly two questions: ` +
            `(1) CLAUDE.md sharing — none / redacted (default, recommended) / full; ` +
            `(2) Activity sharing (tool/skill/MCP usage + permission-mode timing + repo name) — yes / no. ` +
            `Then run: node "${hookPath}" consent --repo "${repoKey}" --claude-md <none|redacted|full> --activity <yes|no>. ` +
            `Nothing is sent for this repo until that command runs.`,
        );
      } else if (consent.activity === "yes") {
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
