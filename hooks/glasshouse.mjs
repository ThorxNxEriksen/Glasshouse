#!/usr/bin/env node
// Glasshouse hook dispatcher + consent CLI. Node built-ins only, zero deps.
//
// Invocation shapes (dispatched on process.argv):
//   node glasshouse.mjs                → hook mode (reads a Claude Code hook payload from stdin)
//   node glasshouse.mjs consent ...    → consent CLI (writes ~/.claude/glasshouse/consent.json)
//   node glasshouse.mjs --self-check   → offline self-check, never touches real files/network
//
// See PLAN.md at the repo root for the full design this implements.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert";
import { execFileSync } from "node:child_process";

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
    if (data && typeof data === "object" && data.supabaseUrl && data.supabasePublishableKey) {
      return data;
    }
    return null;
  } catch {
    return null;
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

// ---------------------------------------------------------------------------
// CLAUDE.md redaction
// ---------------------------------------------------------------------------

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
  if (eventName === "InstructionsLoaded") {
    const sanitized = { ...payload };
    if (consent?.claudeMd !== "full") {
      const redacted = redactClaudeMd(payload?.content ?? payload?.instructions ?? "");
      if ("content" in sanitized) sanitized.content = redacted;
      if ("instructions" in sanitized) sanitized.instructions = redacted;
    }
    return sanitized;
  }
  if (eventName === "PreToolUse") {
    const sanitized = { ...payload };
    if (sanitized.tool_input && typeof sanitized.tool_input === "object") {
      sanitized.tool_input = { file_path: sanitized.tool_input.file_path ?? null };
    }
    return sanitized;
  }
  // SessionStart / SessionEnd / anything else: no content-bearing fields, passthrough.
  return payload;
}

function buildRow({ eventName, payload, consent, config, settingsPath }) {
  const cwd = payload?.cwd ?? process.cwd();
  const row = {
    session_id: payload?.session_id ?? null,
    user_email: config?.userEmail ?? null,
    hostname: os.hostname(),
    hook_event_name: eventName,
    permission_mode: payload?.permission_mode ?? null,
    cwd,
    git_branch: gitBranch(cwd),
    claude_md_share_level: claudeMdShareLevel(consent?.claudeMd),
    raw: sanitizeRaw(payload, eventName, consent),
    client_ts: new Date().toISOString(),
  };

  if (eventName === "SessionStart") {
    row.installed_hooks = readInstalledHooks(settingsPath);
  } else if (eventName === "InstructionsLoaded") {
    const rawContent = payload?.content ?? payload?.instructions ?? "";
    row.content = consent?.claudeMd === "redacted" ? redactClaudeMd(rawContent) : rawContent;
    row.file_path = payload?.file_path ?? payload?.path ?? "";
    row.load_reason = payload?.load_reason ?? payload?.reason ?? "";
  } else if (eventName === "PreToolUse") {
    row.tool_name = payload?.tool_name ?? null;
    row.file_path = payload?.tool_input?.file_path ?? null;
  }
  // SessionEnd: boundary marker — common fields only, no tool_name/content.

  return row;
}

// ---------------------------------------------------------------------------
// Fire-and-forget POST
// ---------------------------------------------------------------------------

async function postEvent(config, row) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      await fetch(`${config.supabaseUrl}/rest/v1/claude_events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: config.supabasePublishableKey,
          Authorization: `Bearer ${config.supabasePublishableKey}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify(row),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // network failure, abort, non-2xx — no retry, no buffering.
  }
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
      if (!consent) {
        const hookPath = String(process.argv[1] ?? "").split(path.sep).join("/");
        const text =
          `Glasshouse usage analytics has no sharing preference on file for this repo yet. ` +
          `Ask the user via AskUserQuestion, exactly two questions: ` +
          `(1) CLAUDE.md sharing — none / redacted (default, recommended) / full; ` +
          `(2) Activity sharing (tool/skill/MCP usage + permission-mode timing) — yes / no. ` +
          `Then run: node "${hookPath}" consent --repo "${repoKey}" --claude-md <none|redacted|full> --activity <yes|no>. ` +
          `Nothing is sent for this repo until that command runs.`;
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
          }) + "\n",
        );
      } else if (consent.activity === "yes") {
        await sendIfConsented(eventName, payload, consent, homeDir, settingsPath);
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
  } finally {
    process.exit(0);
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

// ---------------------------------------------------------------------------
// Self-check — assert-based, no network calls, no real files touched.
// ---------------------------------------------------------------------------

function selfCheck() {
  // redactClaudeMd: keeps headings only, appends exact omitted-count line.
  const content = "# Title\nSome body text\n## Sub\nMore text here";
  const expected = [
    "# Title",
    "## Sub",
    `[glasshouse: body redacted — ${content.split("\n").length} lines / ${content.length} chars omitted]`,
  ].join("\n");
  assert.strictEqual(redactClaudeMd(content), expected);

  // computeRepoKey: falls back to path.resolve(cwd) for a dir with no git remote.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-selfcheck-"));
  try {
    assert.strictEqual(computeRepoKey(tmpDir), path.resolve(tmpDir));

    // loadConsentStore/loadConfig: missing file never throws.
    assert.deepStrictEqual(loadConsentStore(tmpDir), {});
    assert.strictEqual(loadConfig(tmpDir), null);

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
  assert.deepStrictEqual(Object.keys(preToolRow.raw.tool_input), ["file_path"]);

  console.log("OK");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const mode = process.argv[2];

if (mode === "--self-check") {
  selfCheck();
} else if (mode === "consent") {
  runConsentMode(process.argv.slice(3));
} else {
  runHookMode();
}
