"use client";

// Port of the "Agent Glassdoor" Claude Design mock (claude.ai/design project
// 456c8123-11e2-4104-875b-cc9fc485b3ea, Agent Glassdoor.dc.html). This is the
// mock's own labeled "Profile mockup" — a possible future personal-profile
// view for Glasshouse — reproduced with its own demo data, not yet wired to
// the real claude_events views (those don't carry per-repo claude.md text,
// skill-invoker breakdown, or MCP call counts the mock assumes).
import { useState } from "react";
import "./ds.css";
import { Avatar, Badge, Button, Card, StatBlock, Tag } from "./ds";

type PermissionMode = "plan" | "chat" | "auto";
type SessionEventType = "skill" | "compact" | "clear";

interface Repo {
  id: string;
  org: string;
  name: string;
  desc: string;
  runs: number;
  hours: number;
  last: string;
  skills: string[];
  mcp: string[];
  claudeMd: string | null;
}

interface SessionEvent {
  at: number;
  type: SessionEventType;
  label?: string;
}

interface SessionRaw {
  repo: string;
  date: string;
  start: string;
  agents: number;
  skills: string[];
  segments: [PermissionMode, number][];
  events: SessionEvent[];
}

interface Terminal {
  label: string | null;
  offset: number;
  duration: number;
  segments: [PermissionMode, number][];
  events: SessionEvent[];
}

interface RunGroup {
  repo: string;
  date: string;
  startMinutes: number;
  totalMinutes: number;
  agents: number;
  skills: string[];
  terminals: Terminal[];
}

const REPOS: Repo[] = [
  { id: "proposal-engine", org: "intellishore", name: "proposal-engine", desc: "Automates proposal drafting from SharePoint case history and pricing sheets.", runs: 42, hours: 18.4, last: "Jul 27", skills: ["search-customers", "xlsx", "docx"], mcp: ["SharePoint", "Jira"], claudeMd: "Always run search-customers before drafting — never fabricate case metrics.\nCite source documents by SharePoint link.\nPricing in DKK unless the client states otherwise." },
  { id: "design-system", org: "intellishore", name: "design-system", desc: "The @intellishore/design-system component library and Storybook.", runs: 27, hours: 11.2, last: "Jul 26", skills: ["ui-design-system", "skill-creator"], mcp: ["GitHub", "Linear"], claudeMd: "Tokens only — no raw hex, no off-scale spacing.\nPrefer the higher-level primitive over hand-rolled markup.\nEvery PR needs a Storybook entry." },
  { id: "client-portal-api", org: "intellishore", name: "client-portal-api", desc: "Backend services for the client-facing engagement portal.", runs: 14, hours: 9.8, last: "Jul 25", skills: ["docx", "pdf"], mcp: ["Jira", "Confluence"], claudeMd: "FastAPI + SQLAlchemy conventions, explicit typing on every endpoint.\nRun pytest before marking any task done.\nNever log customer PII." },
  { id: "dotfiles", org: "thoreriksen", name: "dotfiles", desc: "Personal shell, tmux, and Claude Code configuration.", runs: 19, hours: 6.5, last: "Jul 24", skills: [], mcp: ["GitHub"], claudeMd: null },
  { id: "cowork-plugins", org: "thoreriksen", name: "cowork-plugins", desc: "Custom Cowork plugins for internal Intellishore workflows.", runs: 11, hours: 5.1, last: "Jul 23", skills: ["skill-creator", "create-cowork-plugin"], mcp: ["GitHub"], claudeMd: "Validate plugin.json against the schema before packaging.\nSkill names are kebab-case, one skill per directory." },
  { id: "internal-market-intelligence", org: "intellishore", name: "internal-market-intelligence", desc: "Go-to-market intelligence platform tracking pharma companies as prospective consulting clients — surfaces regulatory, trial, leadership, and financial signals.", runs: 51, hours: 24.6, last: "Jul 28", skills: ["run", "prod-pipeline-run"], mcp: ["GitHub", "Azure"], claudeMd: "Pharma companies tracked are called accounts — never \"competitors\", even in legacy code.\nSignals must tie to a concrete entity (country, product, TA, tech); generic news is noise.\nMedallion pipeline: bronze -> silver -> gold -> platinum, no backward joins.\nWeekly digest sends Tuesday 06:00 CPH; root CLAUDE.md stays <=150 lines." },
];

const SKILLS_USAGE = [
  { name: "superpowers:subagent-driven-development", byUser: 8, byAgent: 34 },
  { name: "ponytail", byUser: 15, byAgent: 10 },
  { name: "intellishore:ui-design-system", byUser: 12, byAgent: 9 },
  { name: "andrej-karpathy-skills:karpathy-guidelines", byUser: 6, byAgent: 8 },
];
const SKILLS_LATEST_NAME = "ponytail";
const SKILLS_LATEST_DATE = "Jul 29";
const SKILLS_LATEST_URL = "https://github.com/anthropics/skills";

const MCP_USAGE = [
  { name: "Playwright", count: 38 },
  { name: "Context7", count: 22 },
  { name: "draw.io", count: 14 },
];
const MCP_LATEST = "Recently connected Context7";

const HOOKS_LIST = [
  { name: "verify-against-docs", event: "PostToolUse", desc: "Checks a change is consistent with the docs before the task is marked done.", isLatest: true },
  { name: "block-prod-db-writes", event: "PreToolUse", desc: "Blocks any write against a production database connection." },
  { name: "run-storybook-lint", event: "PostToolUse", desc: "Lints new components against the Storybook config." },
  { name: "load-pricing-sheet", event: "SessionStart", desc: "Loads the latest pricing sheet into context." },
];
const HOOKS_LATEST = "Added verify-against-docs post-hook";

const CLAUDE_MD_GLOBAL = {
  path: "~/.claude/CLAUDE.md",
  text: "Explicit variable naming for every Python and SQL snippet. New folders use kebab-case with zero-padded numeric prefixes (01-, 02-...). Prose by default, concise, no filler. Ask clarifying questions before diving into ambiguous requests, and flag Python best practices inline where relevant.",
};
const CLAUDE_MD_LATEST = "Latest: ~/.claude/CLAUDE.md — added “ask before diving into ambiguous requests” rule · Jul 29";
const CLAUDE_MD_RECENT_REPO = { repo: "proposal-engine", date: "Jul 24", summary: "Added DKK-default pricing note" };

const MODE_META: Record<PermissionMode, { label: string; color: string }> = {
  plan: { label: "Plan mode", color: "var(--lavender-500)" },
  chat: { label: "Back-and-forth", color: "var(--warning)" },
  auto: { label: "Auto mode", color: "var(--success)" },
};

const EVENT_META: Record<SessionEventType, { color: string; label: (e: SessionEvent) => string }> = {
  skill: { color: "var(--teal-500)", label: (e) => `Skill invoked · ${e.label ?? ""}` },
  compact: { color: "var(--ink-900)", label: () => "/compact" },
  clear: { color: "var(--danger)", label: () => "/clear" },
};

const SESSIONS: SessionRaw[] = [
  { repo: "internal-market-intelligence", date: "Jul 28", start: "09:02", agents: 3, skills: ["prod-pipeline-run"], segments: [["plan", 9], ["chat", 14], ["auto", 20]], events: [{ at: 9, type: "skill", label: "prod-pipeline-run" }, { at: 30, type: "compact" }] },
  { repo: "internal-market-intelligence", date: "Jul 28", start: "09:07", agents: 2, skills: ["run"], segments: [["chat", 10], ["auto", 25]], events: [{ at: 10, type: "skill", label: "run" }, { at: 33, type: "clear" }] },
  { repo: "internal-market-intelligence", date: "Jul 21", start: "14:10", agents: 2, skills: ["run"], segments: [["plan", 5], ["chat", 10], ["auto", 16]], events: [{ at: 5, type: "skill", label: "run" }] },
  { repo: "proposal-engine", date: "Jul 27", start: "10:00", agents: 3, skills: ["search-customers", "xlsx"], segments: [["plan", 8], ["chat", 12], ["auto", 22]], events: [{ at: 8, type: "skill", label: "search-customers" }] },
  { repo: "design-system", date: "Jul 26", start: "11:15", agents: 1, skills: ["ui-design-system"], segments: [["plan", 5], ["chat", 6]], events: [] },
  { repo: "client-portal-api", date: "Jul 25", start: "09:30", agents: 4, skills: ["docx"], segments: [["plan", 10], ["auto", 35]], events: [] },
  { repo: "dotfiles", date: "Jul 24", start: "16:00", agents: 1, skills: [], segments: [["chat", 9]], events: [] },
  { repo: "cowork-plugins", date: "Jul 23", start: "13:20", agents: 2, skills: ["skill-creator", "create-cowork-plugin"], segments: [["plan", 6], ["chat", 15], ["auto", 18]], events: [] },
  { repo: "proposal-engine", date: "Jul 22", start: "08:45", agents: 2, skills: ["xlsx"], segments: [["plan", 4], ["auto", 26]], events: [] },
  { repo: "design-system", date: "Jul 20", start: "15:00", agents: 1, skills: ["ui-design-system", "skill-creator"], segments: [["chat", 20], ["auto", 10]], events: [] },
  { repo: "client-portal-api", date: "Jul 18", start: "10:10", agents: 3, skills: ["docx", "pdf"], segments: [["plan", 12], ["chat", 8], ["auto", 30]], events: [] },
];

function toMinutes(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function sessionDuration(s: SessionRaw) {
  return s.segments.reduce((sum, [, m]) => sum + m, 0);
}
function dayNumber(dateStr: string) {
  return parseInt(dateStr.replace(/\D/g, ""), 10);
}

function buildRun(cluster: SessionRaw[]): RunGroup {
  const overallStart = Math.min(...cluster.map((s) => toMinutes(s.start)));
  const overallEnd = Math.max(...cluster.map((s) => toMinutes(s.start) + sessionDuration(s)));
  return {
    repo: cluster[0].repo,
    date: cluster[0].date,
    startMinutes: overallStart,
    totalMinutes: overallEnd - overallStart,
    agents: cluster.reduce((sum, s) => sum + s.agents, 0),
    skills: [...new Set(cluster.flatMap((s) => s.skills))],
    terminals: cluster.map((s, i) => ({
      label: cluster.length > 1 ? `Terminal ${i + 1}` : null,
      offset: toMinutes(s.start) - overallStart,
      duration: sessionDuration(s),
      segments: s.segments,
      events: s.events,
    })),
  };
}

function groupOverlappingSessions(sessions: SessionRaw[]): RunGroup[] {
  const byKey: Record<string, SessionRaw[]> = {};
  sessions.forEach((s) => {
    const key = s.repo + "|" + s.date;
    (byKey[key] = byKey[key] || []).push(s);
  });
  const runs: RunGroup[] = [];
  Object.values(byKey).forEach((group) => {
    const sorted = group.slice().sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    let cluster: SessionRaw[] = [];
    let clusterEnd = -Infinity;
    sorted.forEach((s) => {
      const start = toMinutes(s.start);
      const end = start + sessionDuration(s);
      if (cluster.length === 0 || start <= clusterEnd) {
        cluster.push(s);
        clusterEnd = Math.max(clusterEnd, end);
      } else {
        runs.push(buildRun(cluster));
        cluster = [s];
        clusterEnd = end;
      }
    });
    if (cluster.length) runs.push(buildRun(cluster));
  });
  return runs.sort((a, b) => dayNumber(b.date) - dayNumber(a.date) || b.startMinutes - a.startMinutes);
}

const RAW_RUNS = groupOverlappingSessions(SESSIONS);

export default function ProfilePage() {
  const [statuslineOpen, setStatuslineOpen] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);

  const selectRepo = (id: string) => setSelectedRepoId(id);
  const closeRepo = () => setSelectedRepoId(null);

  const heroRuns = REPOS.reduce((s, r) => s + r.runs, 0);
  const heroHours = Math.round(REPOS.reduce((s, r) => s + r.hours, 0)) + "h";
  const heroRepos = REPOS.length;

  const maxSkillTotal = Math.max(...SKILLS_USAGE.map((s) => s.byUser + s.byAgent));
  const skillBars = SKILLS_USAGE.slice()
    .sort((a, b) => b.byUser + b.byAgent - (a.byUser + a.byAgent))
    .map((s) => {
      const total = s.byUser + s.byAgent;
      return { name: s.name, barWidthPct: (total / maxSkillTotal) * 100, userPct: (s.byUser / total) * 100, agentPct: (s.byAgent / total) * 100 };
    });

  const maxMcpCount = Math.max(...MCP_USAGE.map((m) => m.count));
  const mcpBars = MCP_USAGE.slice()
    .sort((a, b) => b.count - a.count)
    .map((m) => ({ name: m.name, count: m.count, barWidthPct: (m.count / maxMcpCount) * 100 }));

  const maxHours = Math.max(...REPOS.map((r) => r.hours));
  const repoList = REPOS.slice()
    .sort((a, b) => b.hours - a.hours)
    .map((r) => ({ ...r, barPct: Math.round((r.hours / maxHours) * 100) }));

  const runViews = RAW_RUNS.map((run) => {
    const repo = REPOS.find((r) => r.id === run.repo)!;
    const isMulti = run.terminals.length > 1;
    const totalSpan = run.totalMinutes;
    const terminals = run.terminals.map((t) => ({
      label: t.label,
      barLeftPct: (t.offset / totalSpan) * 100,
      barWidthPct: (t.duration / totalSpan) * 100,
      segments: t.segments.map(([mode, min]) => ({ color: MODE_META[mode].color, widthPct: (min / t.duration) * 100 })),
      events: t.events.map((ev) => ({ color: EVENT_META[ev.type].color, leftPct: ((t.offset + ev.at) / totalSpan) * 100 })),
    }));
    const hasEvents = run.terminals.some((t) => t.events.length > 0);
    let legendItems: { key: string; color: string; label: string }[] = [];
    let legendShow = false;
    if (!isMulti) {
      legendItems = run.terminals[0].segments.map(([mode, min], si) => ({
        key: String(si),
        color: MODE_META[mode].color,
        label: `${MODE_META[mode].label} · ${min} min`,
      }));
      legendShow = true;
    } else if (hasEvents) {
      legendItems = [
        { key: "skill", color: "var(--teal-500)", label: "Skill invoked" },
        { key: "compact", color: "var(--ink-900)", label: "/compact" },
        { key: "clear", color: "var(--danger)", label: "/clear" },
      ];
      legendShow = true;
    }
    return {
      key: `${run.repo}-${run.date}-${run.terminals[0].offset}`,
      repoId: repo.id,
      repoName: repo.name,
      metaText: `${run.date} · ${totalSpan} min ${isMulti ? "elapsed" : "total"}`,
      agentsLabel: `${run.agents} ${run.agents === 1 ? "agent" : "agents"}`,
      isMulti,
      terminalsLabel: `${run.terminals.length} terminals`,
      terminals,
      legendShow,
      legendItems,
      skillChips: run.skills,
    };
  });

  const selectedRepo = REPOS.find((r) => r.id === selectedRepoId) ?? null;

  return (
    <div className="profile-ds">
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: 64,
          padding: "0 32px",
          background: "var(--surface-card)",
          borderBottom: "1px solid var(--border-subtle)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: "var(--radius-sm)",
              background: "var(--brand)",
              color: "#fff",
              fontWeight: "var(--weight-bold)",
              fontSize: 13,
            }}
          >
            C
          </span>
          <span style={{ fontSize: 15, fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>Claude runs</span>
          <span style={{ fontSize: "var(--text-2xs)", letterSpacing: "var(--tracking-eyebrow)", textTransform: "uppercase", color: "var(--text-muted)" }}>
            Profile mockup
          </span>
        </div>
        <nav style={{ display: "flex", gap: 28 }}>
          <a href="#changes" style={{ fontSize: 13, color: "var(--text-body)" }}>Changes</a>
          <a href="#repos" style={{ fontSize: 13, color: "var(--text-body)" }}>Repos</a>
          <a href="#runs" style={{ fontSize: 13, color: "var(--text-body)" }}>Runs</a>
        </nav>
      </header>

      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 32, display: "flex", flexDirection: "column", gap: 40 }}>
        <Card variant="tint">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <Avatar name="Thor Eriksen" size="lg" />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <h1 style={{ fontFamily: "var(--font-display)", fontWeight: "var(--weight-thin)", fontSize: "var(--text-display-md)", letterSpacing: "var(--tracking-display)", color: "var(--text-strong)" }}>
                  Thor Eriksen
                </h1>
                <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>Consultant &middot; Analytics &amp; Automation @ Intellishore</p>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <a href="https://github.com/thoreriksen" target="_blank" rel="noopener" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                    </svg>
                    github.com/thoreriksen
                  </a>
                  <Button variant="ghost" size="sm" onClick={() => setStatuslineOpen((v) => !v)}>
                    {statuslineOpen ? "Hide status line" : "Show status line"}
                  </Button>
                </div>
                {statuslineOpen && (
                  <div style={{ marginTop: 4, borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 11, overflowX: "auto", whiteSpace: "nowrap" }}>
                    <span style={{ color: "var(--teal-700)" }}>Sonnet &middot; high</span>
                    <span style={{ color: "var(--text-faint)" }}> | </span>
                    <span style={{ color: "var(--success)" }}>6% - 200k</span>
                    <span style={{ color: "var(--text-faint)" }}> | </span>
                    <span style={{ color: "var(--warning)" }}>5h: 56% (13:40)</span>
                    <span style={{ color: "var(--text-faint)" }}> | </span>
                    <span style={{ color: "var(--success)" }}>7d: 64% (Sat 05:00)</span>
                    <span style={{ color: "var(--text-faint)" }}> | </span>
                    <span style={{ color: "var(--lavender-600)" }}>feature/update-to-gio-system</span>
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 36 }}>
              <StatBlock value={heroRuns} label="Total runs" />
              <StatBlock value={heroHours} label="Time with Claude" />
              <StatBlock value={heroRepos} label="Repos" />
            </div>
          </div>
        </Card>

        <section id="changes" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 style={{ fontSize: "var(--text-h2)", fontWeight: "var(--weight-regular)" }}>How I work</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="brand">claude.md</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{CLAUDE_MD_LATEST}</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={eyebrowStyle}>Global</span>
                  <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-bold)" }}>{CLAUDE_MD_GLOBAL.path}</h3>
                  <p style={{ margin: 0, fontSize: "var(--text-sm)", lineHeight: "var(--leading-body)", color: "var(--text-body)" }}>{CLAUDE_MD_GLOBAL.text}</p>
                </div>
                <div
                  onClick={() => selectRepo(CLAUDE_MD_RECENT_REPO.repo)}
                  style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 12, borderTop: "1px solid var(--border-subtle)", cursor: "pointer" }}
                >
                  <span style={eyebrowStyle}>Most recently updated repo</span>
                  <p style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: "var(--weight-bold)", color: "var(--text-link)" }}>{CLAUDE_MD_RECENT_REPO.repo}</p>
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{CLAUDE_MD_RECENT_REPO.summary} &middot; {CLAUDE_MD_RECENT_REPO.date}</p>
                </div>
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="accent">skills</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  Added <a href={SKILLS_LATEST_URL} target="_blank" rel="noopener">{SKILLS_LATEST_NAME}</a> on {SKILLS_LATEST_DATE}
                </p>
                <div style={{ display: "flex", gap: 16 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                    <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: "var(--teal-500)" }} />Invoked by you
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                    <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: "var(--brand)" }} />Invoked by Claude
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {skillBars.map((bar) => (
                    <div key={bar.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{bar.name}</span>
                      <div style={{ height: 10, width: "100%", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)", overflow: "hidden" }}>
                        <div style={{ height: "100%", display: "flex", width: `${bar.barWidthPct}%` }}>
                          <div style={{ height: "100%", background: "var(--teal-500)", width: `${bar.userPct}%` }} />
                          <div style={{ height: "100%", background: "var(--brand)", width: `${bar.agentPct}%` }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="warning">hooks</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{HOOKS_LATEST}</p>
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {HOOKS_LIST.map((hook) => (
                    <div key={hook.name} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{hook.name}</span>
                        <span style={eyebrowStyle}>{hook.event}</span>
                        {hook.isLatest && <Badge tone="warning">new</Badge>}
                      </div>
                      <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{hook.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="success">mcp</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{MCP_LATEST}</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {mcpBars.map((bar) => (
                    <div key={bar.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{bar.name}</span>
                        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{bar.count}</span>
                      </div>
                      <div style={{ height: 10, width: "100%", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)", overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: "var(--radius-pill)", background: "var(--success)", width: `${bar.barWidthPct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 24, alignItems: "start" }}>
          <aside id="repos" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2 style={{ fontSize: "var(--text-h4)", fontWeight: "var(--weight-bold)" }}>Top repos</h2>
              <span style={eyebrowStyle}>by time spent</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {repoList.map((repo) => (
                <Card key={repo.id} interactive onClick={() => selectRepo(repo.id)}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repo.name}</span>
                    <span style={{ ...eyebrowStyle, flex: "0 0 auto" }}>{repo.org}</span>
                  </div>
                  <div style={{ marginTop: 8, height: 6, width: "100%", overflow: "hidden", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)" }}>
                    <div style={{ height: "100%", borderRadius: "var(--radius-pill)", background: "var(--brand)", width: `${repo.barPct}%` }} />
                  </div>
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    <span>{repo.runs} runs</span>
                    <span>{repo.hours}h</span>
                  </div>
                </Card>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>Click a repo to see connected skills &amp; MCP servers.</p>
          </aside>

          <section id="runs" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2 style={{ fontSize: "var(--text-h4)", fontWeight: "var(--weight-bold)" }}>Recent runs</h2>
              <span style={eyebrowStyle}>{runViews.length} shown</span>
            </div>
            {runViews.map((run) => (
              <Card key={run.key}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Tag onClick={() => selectRepo(run.repoId)}>{run.repoName}</Tag>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{run.metaText}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Badge tone="neutral">{run.agentsLabel}</Badge>
                      {run.isMulti && <Badge tone="accent">{run.terminalsLabel}</Badge>}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {run.terminals.map((terminal, ti) => (
                      <div key={ti} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        {terminal.label && (
                          <span style={{ flex: "0 0 72px", fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-muted)" }}>{terminal.label}</span>
                        )}
                        <div style={{ position: "relative", flex: "1 1 auto", height: 10, borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)" }}>
                          <div style={{ position: "absolute", top: 0, height: "100%", display: "flex", overflow: "hidden", borderRadius: "var(--radius-pill)", left: `${terminal.barLeftPct}%`, width: `${terminal.barWidthPct}%` }}>
                            {terminal.segments.map((seg, si) => (
                              <div key={si} style={{ height: "100%", width: `${seg.widthPct}%`, background: seg.color }} />
                            ))}
                          </div>
                          {terminal.events.map((ev, ei) => (
                            <div
                              key={ei}
                              style={{
                                position: "absolute",
                                top: "50%",
                                width: 9,
                                height: 9,
                                marginTop: -4.5,
                                marginLeft: -4.5,
                                borderRadius: 9999,
                                boxShadow: "0 0 0 2px var(--surface-card)",
                                left: `${ev.leftPct}%`,
                                background: ev.color,
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  {run.legendShow && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                      {run.legendItems.map((item) => (
                        <span key={item.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                          <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: item.color }} />
                          {item.label}
                        </span>
                      ))}
                    </div>
                  )}

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {run.skillChips.length > 0 ? (
                      run.skillChips.map((chip) => <Tag key={chip}>{chip}</Tag>)
                    ) : (
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>no skills activated</span>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </section>
        </section>
      </main>

      {selectedRepo && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(20,32,31,0.4)" }} onClick={closeRepo} />
          <aside style={{ position: "fixed", right: 0, top: 0, zIndex: 50, height: "100%", width: "100%", maxWidth: 420, overflowY: "auto", background: "var(--surface-card)", boxShadow: "var(--shadow-xl)", padding: 32 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={eyebrowStyle}>{selectedRepo.org}</span>
              <Button variant="ghost" size="sm" onClick={closeRepo}>Close</Button>
            </div>
            <h2 style={{ margin: "8px 0 0", fontSize: "var(--text-h2)", fontWeight: "var(--weight-regular)" }}>{selectedRepo.name}</h2>
            <p style={{ margin: "8px 0 0", fontSize: "var(--text-sm)", lineHeight: "var(--leading-body)", color: "var(--text-body)" }}>{selectedRepo.desc}</p>
            <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, borderRadius: "var(--radius-card)", background: "var(--surface-sunken)", padding: 16, textAlign: "center" }}>
              <StatBlock value={selectedRepo.runs} label="Runs" />
              <StatBlock value={`${selectedRepo.hours}h`} label="Hours" />
              <StatBlock value={selectedRepo.last} label="Last active" />
            </div>
            <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={eyebrowStyle}>Skills connected</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {selectedRepo.skills.length > 0 ? (
                  selectedRepo.skills.map((s) => <Tag key={s}>{s}</Tag>)
                ) : (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>none activated on this repo yet</span>
                )}
              </div>
            </div>
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={eyebrowStyle}>MCP servers connected</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {selectedRepo.mcp.map((m) => <Badge key={m} tone="solid">{m}</Badge>)}
              </div>
            </div>
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={eyebrowStyle}>claude.md</span>
              <div style={{ borderRadius: "var(--radius-sm)", background: "var(--surface-sunken)", padding: "12px 14px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-body)", whiteSpace: "pre-line" }}>
                {selectedRepo.claudeMd ?? "No repo-level claude.md — inherits the global ~/.claude/CLAUDE.md."}
              </div>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}

const eyebrowStyle = {
  fontSize: "var(--text-2xs)",
  letterSpacing: "var(--tracking-eyebrow)",
  textTransform: "uppercase" as const,
  color: "var(--text-faint)",
};
