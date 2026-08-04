#!/usr/bin/env node
// Glasshouse one-shot installer. Node built-ins only — no npm dependencies.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const HOOK_EVENTS = ["SessionStart", "InstructionsLoaded", "PreToolUse", "SessionEnd"];
// Both are needed at runtime: glasshouse.sh is what settings.json points at, and it
// launches glasshouse.mjs from beside itself.
const HOOK_FILES = ["glasshouse.mjs", "glasshouse.sh"];

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

function copyHookScripts(repoRoot, claudeHome) {
  const hooksDir = path.join(claudeHome, "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const file of HOOK_FILES) {
    fs.copyFileSync(path.join(repoRoot, "glasshouse-plugin", file), path.join(hooksDir, file));
  }
  return hooksDir;
}

function isGlasshouseHook(hook) {
  return typeof hook?.command === "string" && /glasshouse\.(mjs|sh)/.test(hook.command);
}

// Drop every Glasshouse hook, whatever shape it is in. Matching `glasshouse.sh` alone
// would leave a pre-1.1 `node ".../glasshouse.mjs"` entry in place and running beside
// the new one — an upgrade has to replace the command, not add to it. Only our own
// hooks go: an entry that mixes ours with someone else's keeps theirs.
function withoutGlasshouseHooks(entries) {
  return entries
    .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !isGlasshouseHook(h)) }))
    .filter((entry) => entry.hooks.length > 0);
}

// Pure, no I/O: returns a new settings object with glasshouse hook entries
// merged in. Never mutates the input.
function mergeSettings(settings, hooksDir) {
  const result = structuredClone(settings);
  // glasshouse.sh, not glasshouse.mjs: the launcher finds a Node runtime first, because
  // Claude Code ships its own and no longer leaves one on PATH. See docs/hook.md.
  const launcherPath = path.join(hooksDir, "glasshouse.sh").replace(/\\/g, "/");
  const glasshouseCommand = `sh "${launcherPath}"`;

  if (!result.hooks) result.hooks = {};
  for (const event of HOOK_EVENTS) {
    const kept = withoutGlasshouseHooks(result.hooks[event] || []);
    kept.push({ matcher: "*", hooks: [{ type: "command", command: glasshouseCommand }] });
    result.hooks[event] = kept;
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

  // The hook must be launched through glasshouse.sh, never `node` directly: a bare
  // `node` command prints `node: command not found` into the transcript on every tool
  // call for anyone whose Claude Code came from the native installer or the desktop app.
  function assertLaunchesViaWrapper(command) {
    assert.ok(command.includes("glasshouse.sh"), `hook command must run the launcher, got: ${command}`);
    assert.ok(!/^node\b/.test(command), `hook command must not invoke node directly, got: ${command}`);
  }

  function checkMerged(merged) {
    assert.equal(merged.hooks.PreToolUse.length, 2);
    assert.deepStrictEqual(merged.hooks.PreToolUse[0], fixture.hooks.PreToolUse[0]);
    assertLaunchesViaWrapper(merged.hooks.PreToolUse[1].hooks[0].command);
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

  // Upgrading from a pre-1.1 install must REPLACE the old `node ".../glasshouse.mjs"`
  // command, not append beside it — otherwise every event fires twice and the bare-node
  // copy keeps erroring on machines with no Node.
  const legacy = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "node /other/tool.mjs" }] },
        { matcher: "*", hooks: [{ type: "command", command: 'node "/old/hooks/glasshouse.mjs"' }] },
      ],
      SessionStart: [
        { matcher: "*", hooks: [{ type: "command", command: 'node "/old/hooks/glasshouse.mjs"' }] },
      ],
    },
  };
  const upgraded = mergeSettings(legacy, tmpHooksDir);
  for (const event of HOOK_EVENTS) {
    const commands = upgraded.hooks[event].flatMap((e) => e.hooks.map((h) => h.command));
    const ours = commands.filter((c) => c.includes("glasshouse"));
    assert.equal(ours.length, 1, `${event} must end up with exactly one glasshouse hook`);
    assertLaunchesViaWrapper(ours[0]);
  }
  // ...while leaving the unrelated hook that shared the event alone.
  assert.deepStrictEqual(upgraded.hooks.PreToolUse[0], legacy.hooks.PreToolUse[0]);

  // A glasshouse hook sharing an entry with someone else's keeps theirs.
  const shared = mergeSettings(
    {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: 'node "/old/hooks/glasshouse.mjs"' },
              { type: "command", command: "node /someone/else.mjs" },
            ],
          },
        ],
      },
    },
    tmpHooksDir,
  );
  assert.deepStrictEqual(shared.hooks.PreToolUse[0].hooks, [
    { type: "command", command: "node /someone/else.mjs" },
  ]);

  // edge case: settings object with no `hooks` key at all (the `if (!result.hooks)` branch)
  const emptyMerged = mergeSettings({}, tmpHooksDir);
  for (const event of HOOK_EVENTS) {
    assert.equal(emptyMerged.hooks[event].length, 1);
    assertLaunchesViaWrapper(emptyMerged.hooks[event][0].hooks[0].command);
  }

  // buildConfig: email-only by default, url/key included only when given.
  assert.deepStrictEqual(buildConfig({ email: "a@example.com" }), { userEmail: "a@example.com" });
  assert.deepStrictEqual(
    buildConfig({ email: "a@example.com", url: "https://x", key: "k" }),
    { userEmail: "a@example.com", supabaseUrl: "https://x", supabasePublishableKey: "k" },
  );

  // writeConfig / copyHookScripts, isolated in their own temp dir
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

    // Both files, byte-identical. Copying only the .mjs would leave settings.json
    // pointing at a launcher that is not there, and the hook would never run at all.
    const repoRoot = path.dirname(fileURLToPath(import.meta.url));
    copyHookScripts(repoRoot, tmpClaudeHome);
    for (const file of HOOK_FILES) {
      const copied = fs.readFileSync(path.join(tmpClaudeHome, "hooks", file), "utf8");
      const source = fs.readFileSync(path.join(repoRoot, "glasshouse-plugin", file), "utf8");
      assert.equal(copied, source, `${file} must be copied byte-for-byte`);
    }

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
  const hooksDir = copyHookScripts(repoRoot, claudeHome);
  installSettings(claudeHome, hooksDir);
  console.log("Glasshouse installed.");
}

main();
