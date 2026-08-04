"use client";

// Port of the "Agent Glassdoor" Claude Design mock (claude.ai/design project
// 456c8123-11e2-4104-875b-cc9fc485b3ea, Agent Glassdoor.dc.html), wired to
// the real Glasshouse public_profile_events data instead of the mock's demo
// arrays.
//
// A few cards had to be reinterpreted because the real schema doesn't carry
// what the mock assumed:
// - "Skills" is split in two, because the two kinds of skill activation are
//   genuinely different measurements: skills Claude *invokes* (a Skill tool
//   call, so countable per name via skill_name) and *always-on* skills that a
//   plugin injects through a SessionStart hook (no tool call exists to count,
//   so only presence is knowable — from enabled_plugins).
//   The mock's you-vs-Claude split is still not tracked: a hook payload doesn't
//   say whether the user typed /skill or Claude chose it.
// - "Hooks" (named hooks + descriptions) isn't tracked — command strings are
//   deliberately scrubbed to avoid leaking local paths. Shows the real
//   registered hook events + matchers instead.
// - "Repos" are grouped by repo_name (the hook-captured repo identity), not a
//   normalized git repo root, so a repo and a subdirectory/worktree can appear
//   as separate entries. There is no local filesystem path (cwd) available on
//   this public view at all — repo_name is the only repo-identity field.
// - The status line / GitHub link in the mock were fabricated bio flavor
//   text with no tracked equivalent — dropped in favor of the profile's email.
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import "../ds.css";
import { Avatar, Badge, Button, Card, StatBlock, Tag } from "../ds";
import { CodeBlock } from "../CodeBlock";
import { PLUGIN_GITHUB_URLS } from "../skillLinks";
import { getSupabaseClient } from "../../../../lib/supabaseClient";
import { parseMcpServer } from "../../../../lib/mcp";

interface SessionRow {
  user_email: string;
  session_id: string;
  repo_name: string | null;
  started_at: string;
  ended_at: string;
  active_ms: number;
  wallclock_ms: number;
  segments: { mode: string; ms: number }[];
  tool_counts: Record<string, number>;
  skill_counts: Record<string, number>;
  agent_calls: number;
}
interface UserTotals {
  session_count: number;
  repo_day_run_count: number;
  repo_count: number;
  active_ms: number;
  tool_counts: Record<string, number>;
  skill_counts: Record<string, number>;
}
interface UserSnapshot {
  installed_hooks: Record<string, string[]> | null;
  enabled_plugins: string[] | null;
  // One entry per plugin that injects a skill at SessionStart — a strict subset of
  // enabled_plugins. skill is null when the name couldn't be inferred safely.
  always_on_skills: { plugin: string; skill: string | null }[] | null;
}
interface ClaudeMdRow {
  memory_type: string;
  repo_name: string | null;
  content: string;
  client_ts: string;
}

const MODE_COLORS: Record<string, string> = {
  plan: "var(--lavender-500)",
  chat: "var(--warning)",
  default: "var(--warning)",
  auto: "var(--success)",
  acceptEdits: "var(--success)",
  dontAsk: "var(--danger)",
  bypassPermissions: "var(--danger)",
  waiting: "var(--grey-300)",
};
const MODE_LABELS: Record<string, string> = {
  plan: "Plan mode",
  chat: "Back-and-forth",
  default: "Back-and-forth",
  auto: "Auto mode",
  acceptEdits: "Accept edits",
  dontAsk: "Don't ask",
  bypassPermissions: "Bypass permissions",
  waiting: "Waiting for input",
};

function modeColor(mode: string) {
  return MODE_COLORS[mode] ?? "var(--grey-300)";
}
function modeLabel(mode: string) {
  return MODE_LABELS[mode] ?? mode;
}

function formatRelative(ms: number) {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function dayKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}
function dayLabel(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Adapts a public_session_summary row to the shape the timeline code below
// already speaks (sessionId/repoKey/startMs/endMs/...), so buildRun and
// groupSessionsByRepoDay don't need to change at all.
function toAgg(r: SessionRow) {
  return {
    sessionId: r.session_id,
    repoKey: r.repo_name ?? "(unknown repo)",
    startMs: new Date(r.started_at).getTime(),
    endMs: new Date(r.ended_at).getTime(),
    segments: r.segments,
    activeMs: r.active_ms,
    toolCounts: r.tool_counts,
    skillCounts: r.skill_counts,
    agentCalls: r.agent_calls,
  };
}
type SessionAgg = ReturnType<typeof toAgg>;

interface Terminal {
  label: string | null;
  offsetMs: number;
  durationMs: number;
  segments: { mode: string; ms: number }[];
}
interface RunGroup {
  repoKey: string;
  startMs: number;
  totalMs: number;
  agents: number;
  terminals: Terminal[];
}

function buildRun(cluster: SessionAgg[]): RunGroup {
  const startMs = Math.min(...cluster.map((s) => s.startMs));
  const endMs = Math.max(...cluster.map((s) => s.endMs));
  return {
    repoKey: cluster[0].repoKey,
    startMs,
    totalMs: endMs - startMs,
    agents: cluster.reduce((sum, s) => sum + 1 + s.agentCalls, 0),
    terminals: cluster.map((s, i) => ({
      label: cluster.length > 1 ? `Terminal ${i + 1}` : null,
      offsetMs: s.startMs - startMs,
      durationMs: s.endMs - s.startMs || 1,
      segments: s.segments,
    })),
  };
}

// One run per repo per day — no overlap sub-clustering. Two same-repo
// sessions on the same day are the same run even with a time gap between them.
function groupSessionsByRepoDay(sessions: SessionAgg[]): RunGroup[] {
  const byKey = new Map<string, SessionAgg[]>();
  for (const s of sessions) {
    const key = `${s.repoKey}|${dayKey(s.startMs)}`;
    const list = byKey.get(key);
    if (list) list.push(s);
    else byKey.set(key, [s]);
  }

  const runs: RunGroup[] = [];
  for (const group of byKey.values()) {
    // Sort so Terminal 1/2/3 labels stay chronological.
    const sorted = group.slice().sort((a, b) => a.startMs - b.startMs);
    runs.push(buildRun(sorted));
  }
  return runs.sort((a, b) => b.startMs - a.startMs);
}

function topEntries(counts: Record<string, number>, n: number) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

// Plugin-skill names follow a `plugin:skill-name` convention. Link out to the
// plugin's GitHub repo when the prefix is a known plugin; never guess a URL
// for unmapped prefixes or bare (non-plugin) skill names.
function skillNameNode(name: string) {
  const sep = name.indexOf(":");
  if (sep === -1) return name;
  const url = PLUGIN_GITHUB_URLS[name.slice(0, sep)];
  if (!url) return name;
  return (
    <a href={url} target="_blank" rel="noreferrer">
      {name}
    </a>
  );
}

const eyebrowStyle = {
  fontSize: "var(--text-2xs)",
  letterSpacing: "var(--tracking-eyebrow)",
  textTransform: "uppercase" as const,
  color: "var(--text-faint)",
};

export default function ProfilePage() {
  const { email: rawEmail } = useParams<{ email: string }>();
  // useParams() on the client doesn't decode the segment the way the
  // server-side `params` prop does, so an encodeURIComponent'd link (e.g.
  // "%40" for "@") arrives here still encoded.
  const email = rawEmail ? decodeURIComponent(rawEmail) : rawEmail;
  const [totals, setTotals] = useState<UserTotals | null>(null);
  const [sessionRows, setSessionRows] = useState<SessionRow[] | null>(null);
  const [snapshot, setSnapshot] = useState<UserSnapshot | null>(null);
  const [claudeMd, setClaudeMd] = useState<ClaudeMdRow[]>([]);
  const [selectedRepoKey, setSelectedRepoKey] = useState<string | null>(null);

  useEffect(() => {
    if (!email) return;
    let cancelled = false;
    const client = getSupabaseClient();

    Promise.all([
      client.from("public_user_totals").select("*").eq("user_email", email).maybeSingle(),
      client
        .from("public_session_summary")
        .select("*")
        .eq("user_email", email)
        // PostgREST caps every response at 1000 rows regardless of what's
        // requested here (confirmed via Content-Range on the live project) —
        // ~43 sessions per user leaves huge headroom, but keep the ceiling
        // explicit since PostgREST enforces it silently.
        .order("started_at", { ascending: false })
        .limit(1000),
      client.from("public_user_snapshot").select("*").eq("user_email", email).maybeSingle(),
      client.from("public_claude_md_latest").select("*").eq("user_email", email),
    ]).then(([totalsRes, sessionsRes, snapshotRes, claudeMdRes]) => {
      if (cancelled) return;
      setTotals(!totalsRes.error && totalsRes.data ? (totalsRes.data as UserTotals) : null);
      setSessionRows(!sessionsRes.error && sessionsRes.data ? (sessionsRes.data as SessionRow[]) : []);
      setSnapshot(!snapshotRes.error && snapshotRes.data ? (snapshotRes.data as UserSnapshot) : null);
      setClaudeMd(!claudeMdRes.error && claudeMdRes.data ? (claudeMdRes.data as ClaudeMdRow[]) : []);
    });

    return () => {
      cancelled = true;
    };
  }, [email]);

  // Mapped once and shared by groupSessionsByRepoDay, repoList, and
  // selectedRepo below, so the timeline code keeps reading s.activeMs /
  // s.toolCounts without a second pass over sessionRows.
  const aggs = useMemo(() => (sessionRows ? sessionRows.map(toAgg) : []), [sessionRows]);
  const runs = useMemo(() => groupSessionsByRepoDay(aggs), [aggs]);

  if (sessionRows === null) return null;

  const heroRuns = totals?.repo_day_run_count ?? 0;
  const heroHours = Math.round((totals?.active_ms ?? 0) / 3600000) + "h";
  const heroRepos = totals?.repo_count ?? 0;

  const allTools = totals?.tool_counts ?? {};

  // Invoked skills: countable, because each one is a real Skill tool call.
  const allSkills = totals?.skill_counts ?? {};
  const totalSkillCalls = Object.values(allSkills).reduce((a, b) => a + b, 0);
  const maxSkillCount = Math.max(1, ...topEntries(allSkills, 8).map(([, c]) => c));
  const skillBars = topEntries(allSkills, 8).map(([name, count]) => ({ name, count, pct: (count / maxSkillCount) * 100 }));

  // The two static measurements. Deliberately separate: enabled plugins are a
  // capability surface (what is installed), always-on skills are the one
  // skill per plugin that is in context every session and can never appear
  // as a Skill call. Neither is a count.
  const enabledPlugins = snapshot?.enabled_plugins ?? [];
  const alwaysOnSkills = snapshot?.always_on_skills ?? [];
  const installedHooks = snapshot?.installed_hooks ?? null;

  const mcpCounts: Record<string, number> = {};
  for (const [tool, count] of Object.entries(allTools)) {
    const server = parseMcpServer(tool);
    if (server) mcpCounts[server] = (mcpCounts[server] ?? 0) + count;
  }
  const maxMcpCount = Math.max(1, ...topEntries(mcpCounts, 5).map(([, c]) => c));
  const mcpBars = topEntries(mcpCounts, 5).map(([name, count]) => ({ name, count, pct: (count / maxMcpCount) * 100 }));

  // public_claude_md_latest carries exactly one User-scope row per user.
  const globalRow = claudeMd.find((r) => r.memory_type === "User");
  const recentProjectRow = claudeMd
    .filter((r) => r.memory_type === "Project")
    .sort((a, b) => new Date(b.client_ts).getTime() - new Date(a.client_ts).getTime())[0];

  const repoList = Array.from(new Set(aggs.map((s) => s.repoKey)))
    .map((repoKey) => {
      const repoSessions = aggs.filter((s) => s.repoKey === repoKey);
      const hours = repoSessions.reduce((sum, s) => sum + s.activeMs, 0) / 3600000;
      const lastActiveMs = Math.max(...repoSessions.map((s) => s.endMs));
      return { repoKey, name: repoKey, runs: repoSessions.length, hours, lastActiveMs };
    })
    .sort((a, b) => b.hours - a.hours);
  const maxRepoHours = Math.max(0.01, ...repoList.map((r) => r.hours));

  const runViews = runs.slice(0, 20).map((run) => {
    const isMulti = run.terminals.length > 1;
    const totalSpan = run.totalMs || 1;
    const terminals = run.terminals.map((t) => ({
      label: t.label,
      barLeftPct: (t.offsetMs / totalSpan) * 100,
      barWidthPct: (t.durationMs / totalSpan) * 100,
      segments: t.segments.map((seg) => ({ color: modeColor(seg.mode), widthPct: (seg.ms / t.durationMs) * 100 })),
    }));
    const singleSegments = !isMulti ? run.terminals[0].segments : [];
    const totalMinutes = Math.round(run.totalMs / 60000);
    const legendItems = !isMulti
      ? singleSegments.map((seg, si) => ({ key: String(si), color: modeColor(seg.mode), label: `${modeLabel(seg.mode)} · ${Math.round(seg.ms / 60000)} min` }))
      : [];
    return {
      key: `${run.repoKey}-${run.startMs}`,
      repoKey: run.repoKey,
      repoName: run.repoKey,
      metaText: `${dayLabel(run.startMs)} · ${totalMinutes} min ${isMulti ? "elapsed" : "total"}`,
      agentsLabel: `${run.agents} ${run.agents === 1 ? "agent" : "agents"}`,
      sessionsLabel: `${run.terminals.length} session${run.terminals.length === 1 ? "" : "s"}`,
      terminals,
      legendItems,
    };
  });

  const selectedRepo = selectedRepoKey
    ? (() => {
        const meta = repoList.find((r) => r.repoKey === selectedRepoKey);
        const repoSessions = aggs.filter((s) => s.repoKey === selectedRepoKey);
        const tools: Record<string, number> = {};
        for (const s of repoSessions) {
          for (const [name, count] of Object.entries(s.toolCounts)) {
            tools[name] = (tools[name] ?? 0) + count;
          }
        }
        const mcp: Record<string, number> = {};
        for (const [tool, count] of Object.entries(tools)) {
          const server = parseMcpServer(tool);
          if (server) mcp[server] = (mcp[server] ?? 0) + count;
        }
        const claudeMdRow = claudeMd.find(
          (r) => r.memory_type === "Project" && (r.repo_name ?? "(unknown repo)") === selectedRepoKey && r.content
        );
        return {
          repoKey: selectedRepoKey,
          name: selectedRepoKey,
          runs: meta?.runs ?? 0,
          hours: meta?.hours ?? 0,
          lastActiveMs: meta?.lastActiveMs ?? 0,
          tools: topEntries(tools, 6).map(([name]) => name),
          mcp: Object.keys(mcp),
          claudeMdText: claudeMdRow?.content ?? null,
        };
      })()
    : null;

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
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12, textDecoration: "none" }}>
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
        </Link>
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
              <Avatar name={email ?? "?"} size="lg" />
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <h1 style={{ fontFamily: "var(--font-display)", fontWeight: "var(--weight-thin)", fontSize: "var(--text-display-md)", letterSpacing: "var(--tracking-display)", color: "var(--text-strong)" }}>
                  {email}
                </h1>
                <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>Glasshouse activity</p>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="brand">claude.md</Badge>
                {globalRow ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <span style={eyebrowStyle}>Global · {formatRelative(new Date(globalRow.client_ts).getTime())}</span>
                    <h3 style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-bold)" }}>~/.claude/CLAUDE.md</h3>
                    {globalRow.content ? (
                      <details>
                        <summary style={{ cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: "var(--weight-bold)", color: "var(--text-link)" }}>
                          View contents
                        </summary>
                        <div style={{ marginTop: 8 }}>
                          <CodeBlock text={globalRow.content} />
                        </div>
                      </details>
                    ) : (
                      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-faint)" }}>Not captured yet — will populate after your next session.</p>
                    )}
                  </div>
                ) : (
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No global CLAUDE.md load recorded yet.</p>
                )}
                {recentProjectRow && (
                  <div
                    onClick={() => setSelectedRepoKey(recentProjectRow.repo_name ?? "(unknown repo)")}
                    style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 12, borderTop: "1px solid var(--border-subtle)", cursor: "pointer" }}
                  >
                    <span style={eyebrowStyle}>Most recently updated repo</span>
                    <p style={{ margin: 0, fontSize: "var(--text-sm)", fontWeight: "var(--weight-bold)", color: "var(--text-link)" }}>
                      {recentProjectRow.repo_name ?? "(unknown repo)"}
                    </p>
                    <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{formatRelative(new Date(recentProjectRow.client_ts).getTime())}</p>
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="brand">skills</Badge>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <span style={eyebrowStyle}>Invoked</span>
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    {totalSkillCalls} invocation{totalSkillCalls === 1 ? "" : "s"} across {Object.keys(allSkills).length} skill
                    {Object.keys(allSkills).length === 1 ? "" : "s"}
                  </p>
                  {skillBars.length === 0 && (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No named skill invocations recorded yet.</span>
                  )}
                  {skillBars.map((bar) => (
                    <div key={bar.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{skillNameNode(bar.name)}</span>
                      <div title={String(bar.count)} style={{ height: 10, width: "100%", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)", overflow: "hidden" }}>
                        <div style={{ height: "100%", background: "var(--lavender-500)", width: `${bar.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 12, borderTop: "1px solid var(--border-subtle)" }}>
                  <span style={eyebrowStyle}>Always on</span>
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    Injected into context every session by a plugin&rsquo;s SessionStart hook — active, not counted
                  </p>
                  {alwaysOnSkills.length === 0 ? (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>
                      No always-on skills recorded yet.
                    </span>
                  ) : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {alwaysOnSkills.map(({ plugin, skill }) => (
                        // Fall back to the plugin when the skill name couldn't be
                        // inferred — better a coarser label than a wrong one.
                        <Tag key={plugin}>{skill ?? plugin.split("@")[0]}</Tag>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="warning">hooks</Badge>
                {installedHooks ? (
                  <>
                    <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                      Registered on your machine
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {Object.entries(installedHooks).map(([eventName, matchers]) => (
                        <div key={eventName} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8, borderBottom: "1px solid var(--border-subtle)" }}>
                          <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{eventName}</span>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                            {matchers.map((m, i) => <Tag key={i}>{m}</Tag>)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No hook registration recorded yet.</p>
                )}
              </div>
            </Card>

            {/* Configuration, not activity: which plugins are installed says nothing
                about which of their skills ran — that lives in the skills card. */}
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="accent">plugins</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  {enabledPlugins.length} enabled — the skills available to reach for, not a usage count
                </p>
                {enabledPlugins.length === 0 ? (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No enabled plugins recorded yet.</span>
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {enabledPlugins.map((name) => (
                      <Tag key={name}>{name.split("@")[0]}</Tag>
                    ))}
                  </div>
                )}
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="success">mcp</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  {Object.values(mcpCounts).reduce((a, b) => a + b, 0)} MCP calls across {Object.keys(mcpCounts).length} servers
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {mcpBars.length === 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No MCP activity recorded yet.</span>}
                  {mcpBars.map((bar) => (
                    <div key={bar.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{bar.name}</span>
                      <div title={String(bar.count)} style={{ height: 10, width: "100%", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)", overflow: "hidden" }}>
                        <div style={{ height: "100%", borderRadius: "var(--radius-pill)", background: "var(--success)", width: `${bar.pct}%` }} />
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
              {repoList.length === 0 && <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No sessions recorded yet.</p>}
              {repoList.map((repo) => (
                <Card key={repo.repoKey} interactive onClick={() => setSelectedRepoKey(repo.repoKey)}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontSize: "var(--text-sm)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repo.name}</span>
                  </div>
                  <div style={{ marginTop: 8, height: 6, width: "100%", overflow: "hidden", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)" }}>
                    <div style={{ height: "100%", borderRadius: "var(--radius-pill)", background: "var(--brand)", width: `${Math.round((repo.hours / maxRepoHours) * 100)}%` }} />
                  </div>
                  <div style={{ marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                    <span>{repo.runs} runs</span>
                    <span>{repo.hours.toFixed(1)}h</span>
                  </div>
                </Card>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>Click a repo to see connected tools &amp; MCP servers.</p>
          </aside>

          <section id="runs" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h2 style={{ fontSize: "var(--text-h4)", fontWeight: "var(--weight-bold)" }}>Recent runs</h2>
              <span style={eyebrowStyle}>{runViews.length} shown</span>
            </div>
            {runViews.length === 0 && <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No runs recorded yet.</p>}
            {runViews.map((run) => (
              <Card key={run.key}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Tag onClick={() => setSelectedRepoKey(run.repoKey)}>{run.repoName}</Tag>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{run.metaText}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Badge tone="neutral">{run.agentsLabel}</Badge>
                      <Badge tone="accent">{run.sessionsLabel}</Badge>
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
                        </div>
                      </div>
                    ))}
                  </div>

                  {run.legendItems.length > 0 && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                      {run.legendItems.map((item) => (
                        <span key={item.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-body)" }}>
                          <i style={{ display: "inline-block", width: 8, height: 8, borderRadius: 9999, background: item.color }} />
                          {item.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </section>
        </section>
      </main>

      {selectedRepo && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(20,32,31,0.4)" }} onClick={() => setSelectedRepoKey(null)} />
          <aside style={{ position: "fixed", right: 0, top: 0, zIndex: 50, height: "100%", width: "100%", maxWidth: 420, overflowY: "auto", background: "var(--surface-card)", boxShadow: "var(--shadow-xl)", padding: 32 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
              <Button variant="ghost" size="sm" onClick={() => setSelectedRepoKey(null)}>Close</Button>
            </div>
            <h2 style={{ margin: "8px 0 0", fontSize: "var(--text-h2)", fontWeight: "var(--weight-regular)" }}>{selectedRepo.name}</h2>
            <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, borderRadius: "var(--radius-card)", background: "var(--surface-sunken)", padding: 16, textAlign: "center" }}>
              <StatBlock value={selectedRepo.runs} label="Runs" />
              <StatBlock value={`${selectedRepo.hours.toFixed(1)}h`} label="Hours" />
              <StatBlock value={selectedRepo.lastActiveMs ? formatRelative(selectedRepo.lastActiveMs) : "—"} label="Last active" />
            </div>
            <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={eyebrowStyle}>Tools used</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {selectedRepo.tools.length > 0 ? (
                  selectedRepo.tools.map((s) => <Tag key={s}>{s}</Tag>)
                ) : (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>none recorded yet</span>
                )}
              </div>
            </div>
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={eyebrowStyle}>MCP servers connected</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {selectedRepo.mcp.length > 0 ? (
                  selectedRepo.mcp.map((m) => <Badge key={m} tone="solid">{m}</Badge>)
                ) : (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>none recorded yet</span>
                )}
              </div>
            </div>
            <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 10 }}>
              <span style={eyebrowStyle}>claude.md</span>
              {selectedRepo.claudeMdText ? (
                <details>
                  <summary style={{ cursor: "pointer", fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-link)" }}>
                    View contents
                  </summary>
                  <div style={{ marginTop: 8 }}>
                    <CodeBlock text={selectedRepo.claudeMdText} />
                  </div>
                </details>
              ) : (
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>Not captured yet for this repo.</span>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
