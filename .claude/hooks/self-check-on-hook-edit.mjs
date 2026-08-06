#!/usr/bin/env node
// PostToolUse guard: after an Edit/Write to glasshouse-plugin/glasshouse.mjs,
// run its offline --self-check so a broken invariant (see docs/hook.md) is
// caught immediately instead of at the next session's drift warning.
import { spawnSync } from "node:child_process";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const filePath = (payload?.tool_input?.file_path ?? "").replace(/\\/g, "/");
if (!filePath.endsWith("glasshouse-plugin/glasshouse.mjs")) {
  process.exit(0);
}

const cwd = payload?.cwd ?? process.cwd();
const result = spawnSync(
  process.execPath,
  ["glasshouse-plugin/glasshouse.mjs", "--self-check"],
  { stdio: "inherit", cwd },
);
process.exit(result.status ?? 1);
