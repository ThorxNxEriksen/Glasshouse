#!/usr/bin/env node
// PreToolUse guard on `gh pr create` (wired via the `if` matcher in settings.json,
// so this only spawns for that exact command). Diffs the branch against
// origin/master; if nothing in the paths covered by
// .claude/agents/data-integrity-reviewer.md changed, allows silently. If
// something did, runs that checklist headlessly and surfaces findings as an
// "ask" permission decision instead of blocking outright — see backlog.md
// #1/#4/#6 for why this checklist exists.
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

const cwd = payload?.cwd ?? process.cwd();

function allow() {
  process.exit(0);
}

function ask(reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

const diff = spawnSync("git", ["diff", "--name-only", "origin/master...HEAD"], {
  cwd,
  encoding: "utf8",
});
if (diff.status !== 0) {
  // Can't compute the diff (no origin/master, detached, etc.) — don't block
  // PR creation over a hook-infrastructure problem.
  allow();
}

const changed = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
const RELEVANT = [
  (f) => f.startsWith("frontend/src/app/"),
  (f) => f === "schema.sql",
  (f) => f === "glasshouse-plugin/glasshouse.mjs",
];
const touched = changed.filter((f) => RELEVANT.some((test) => test(f)));

if (touched.length === 0) {
  allow();
}

const prompt = [
  "Read .claude/agents/data-integrity-reviewer.md in this repo and apply its",
  "checklist to `git diff origin/master...HEAD`. These files changed:",
  touched.join(", "),
  "",
  "Report findings in the format the checklist specifies. If there are no",
  "findings, output exactly the line: NO FINDINGS",
].join("\n");

const review = spawnSync(
  "claude",
  [
    "-p",
    prompt,
    "--allowedTools",
    "Read,Grep,Glob,Bash",
    "--output-format",
    "text",
  ],
  { cwd, encoding: "utf8", timeout: 180000 },
);

const output = (review.stdout || "").trim();
if (review.status !== 0 || output === "") {
  ask(
    `data-integrity-reviewer could not complete (exit ${review.status}). ` +
      `Touched: ${touched.join(", ")}. Review manually before merging.`,
  );
}
if (output.includes("NO FINDINGS")) {
  allow();
}
ask(output);
