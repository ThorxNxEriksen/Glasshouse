#!/usr/bin/env node
// Glasshouse one-shot installer. Node built-ins only — no npm dependencies.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HOOK_EVENTS = ["SessionStart", "InstructionsLoaded", "PreToolUse", "SessionEnd"];

// ---- pure / parameterized functions -------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.match(/^--(url|key|email)=(.*)$/);
    if (eq) {
      args[eq[1]] = eq[2];
    } else if (a === "--url" || a === "--key" || a === "--email") {
      args[a.slice(2)] = argv[++i];
    }
  }
  return args;
}

function writeConfig(claudeHome, config) {
  const dir = path.join(claudeHome, "glasshouse");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
}

function buildConfig({ email, url, key }) {
  const config = { userEmail: email };
  if (url) config.supabaseUrl = url;
  if (key) config.supabasePublishableKey = key;
  return config;
}

function copyHookScript(repoRoot, claudeHome) {
  const hooksDir = path.join(claudeHome, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "glasshouse-plugin", "glasshouse.mjs"),
    path.join(hooksDir, "glasshouse.mjs")
  );
  return hooksDir;
}

// Pure, no I/O: returns a new settings object with glasshouse hook entries
// merged in. Never mutates the input.
function mergeSettings(settings, hooksDir) {
  const result = structuredClone(settings);
  const glasshouseMjsPath = path.join(hooksDir, "glasshouse.mjs").replace(/\\/g, "/");
  const glasshouseCommand = `node "${glasshouseMjsPath}"`;

  if (!result.hooks) result.hooks = {};
  for (const event of HOOK_EVENTS) {
    if (!result.hooks[event]) result.hooks[event] = [];
    const alreadyInstalled = result.hooks[event].some((entry) =>
      (entry.hooks || []).some(
        (h) => typeof h.command === "string" && h.command.includes("glasshouse.mjs")
      )
    );
    if (alreadyInstalled) continue;
    result.hooks[event].push({
      matcher: "*",
      hooks: [{ type: "command", command: glasshouseCommand }],
    });
  }
  return result;
}

function installSettings(claudeHome, hooksDir) {
  const settingsPath = path.join(claudeHome, "settings.json");
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  }
  const merged = mergeSettings(settings, hooksDir);
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + "\n");
  return merged;
}

function getDefaultEmail() {
  try {
    return execSync("git config --global user.email", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// ---- self-check (temp dirs only, never touches ~/.claude/*) -------------

function selfCheck() {
  const fixture = {
    permissions: { defaultMode: "auto" },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|PowerShell",
          hooks: [
            {
              type: "command",
              command:
                'node "C:/Users/ThorNoergaardEriksen/.claude/hooks/block-destructive-git.mjs"',
            },
          ],
        },
      ],
    },
    statusLine: {
      type: "command",
      command: "bash /c/Users/ThorNoergaardEriksen/.claude/statusline-command.sh",
    },
    enabledPlugins: { a: true, b: false },
    extraKnownMarketplaces: { x: { source: { source: "github", repo: "example/example" } } },
    effortLevel: "high",
    autoUpdatesChannel: "latest",
    skipAutoPermissionPrompt: true,
    model: "sonnet",
  };
  const untouchedKeys = [
    "permissions",
    "statusLine",
    "enabledPlugins",
    "extraKnownMarketplaces",
    "effortLevel",
    "autoUpdatesChannel",
    "skipAutoPermissionPrompt",
    "model",
  ];

  const tmpHooksDir = path.join(os.tmpdir(), "glasshouse-selfcheck-hooksdir");

  function checkMerged(merged) {
    assert.equal(merged.hooks.PreToolUse.length, 2);
    assert.deepStrictEqual(merged.hooks.PreToolUse[0], fixture.hooks.PreToolUse[0]);
    assert.ok(merged.hooks.PreToolUse[1].hooks[0].command.includes("glasshouse.mjs"));
    for (const event of ["SessionStart", "InstructionsLoaded", "SessionEnd"]) {
      assert.equal(merged.hooks[event].length, 1);
    }
    for (const key of untouchedKeys) {
      assert.deepStrictEqual(merged[key], fixture[key]);
    }
  }

  const merged1 = mergeSettings(fixture, tmpHooksDir);
  checkMerged(merged1);
  const merged2 = mergeSettings(merged1, tmpHooksDir);
  checkMerged(merged2);
  // fixture itself must remain untouched by either call (mergeSettings is pure)
  assert.equal(fixture.hooks.PreToolUse.length, 1);

  // edge case: settings object with no `hooks` key at all (the `if (!result.hooks)` branch)
  const emptyMerged = mergeSettings({}, tmpHooksDir);
  for (const event of HOOK_EVENTS) {
    assert.equal(emptyMerged.hooks[event].length, 1);
    assert.ok(emptyMerged.hooks[event][0].hooks[0].command.includes("glasshouse.mjs"));
  }

  // buildConfig: email-only by default, url/key included only when given.
  assert.deepStrictEqual(buildConfig({ email: "a@example.com" }), { userEmail: "a@example.com" });
  assert.deepStrictEqual(
    buildConfig({ email: "a@example.com", url: "https://x", key: "k" }),
    { userEmail: "a@example.com", supabaseUrl: "https://x", supabasePublishableKey: "k" },
  );

  // writeConfig / copyHookScript, isolated in their own temp dir
  const tmpClaudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "glasshouse-selfcheck-"));
  try {
    const config = {
      supabaseUrl: "https://example.supabase.co",
      supabasePublishableKey: "pk_test_example",
      userEmail: "test@example.com",
    };
    writeConfig(tmpClaudeHome, config);
    const writtenConfig = JSON.parse(
      fs.readFileSync(path.join(tmpClaudeHome, "glasshouse", "config.json"), "utf8")
    );
    assert.deepStrictEqual(writtenConfig, config);

    const repoRoot = path.dirname(fileURLToPath(import.meta.url));
    copyHookScript(repoRoot, tmpClaudeHome);
    const copied = fs.readFileSync(path.join(tmpClaudeHome, "hooks", "glasshouse.mjs"), "utf8");
    const source = fs.readFileSync(path.join(repoRoot, "glasshouse-plugin", "glasshouse.mjs"), "utf8");
    assert.equal(copied, source);

    // edge case: real first-run scenario — settings.json does not exist yet
    const settingsPath = path.join(tmpClaudeHome, "settings.json");
    assert.equal(fs.existsSync(settingsPath), false);
    const installedHooksDir = path.join(tmpClaudeHome, "hooks");
    const installed = installSettings(tmpClaudeHome, installedHooksDir);
    for (const event of HOOK_EVENTS) {
      assert.equal(installed.hooks[event].length, 1);
    }
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.deepStrictEqual(onDisk, installed);
  } finally {
    fs.rmSync(tmpClaudeHome, { recursive: true, force: true });
  }

  console.log("OK");
}

// ---- main (only place that touches real ~/.claude/*) --------------------

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-check")) {
    selfCheck();
    return;
  }

  const args = parseArgs(argv);
  const email = args.email !== undefined ? args.email : getDefaultEmail();

  const claudeHome = path.join(os.homedir(), ".claude");
  const repoRoot = path.dirname(fileURLToPath(import.meta.url));

  writeConfig(claudeHome, buildConfig({ email, url: args.url, key: args.key }));
  const hooksDir = copyHookScript(repoRoot, claudeHome);
  installSettings(claudeHome, hooksDir);
  console.log("Glasshouse installed.");
}

main();
