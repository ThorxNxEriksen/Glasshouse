"use client";

// Public user directory — no auth. Lists everyone who has opted into sharing
// Glasshouse activity (per the public_* views, which only expose what a user
// has consented to publish) and rolls up site-wide tool/skill/plugin stats.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import "./profile/ds.css";
import { Badge, Card, StatBlock, Tag } from "./profile/ds";
import { getSupabaseClient } from "../../lib/supabaseClient";
import { parseMcpServer } from "../../lib/mcp";

interface DirectoryRow {
  user_email: string;
  last_active: string;
  run_count: number;
}
interface ToolTotal {
  tool_name: string;
  call_count: number;
}
interface SkillTotal {
  skill_name: string;
  call_count: number;
}
interface PluginAdoption {
  plugin_name: string;
  user_count: number;
}

function formatRelative(ms: number) {
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function topEntries(counts: Record<string, number>, n: number) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

const eyebrowStyle = {
  fontSize: "var(--text-2xs)",
  letterSpacing: "var(--tracking-eyebrow)",
  textTransform: "uppercase" as const,
  color: "var(--text-faint)",
};

export default function DirectoryPage() {
  const [directory, setDirectory] = useState<DirectoryRow[] | null>(null);
  const [toolTotals, setToolTotals] = useState<ToolTotal[]>([]);
  const [skillTotals, setSkillTotals] = useState<SkillTotal[]>([]);
  const [pluginAdoption, setPluginAdoption] = useState<PluginAdoption[]>([]);

  useEffect(() => {
    let cancelled = false;
    const supabase = getSupabaseClient();

    supabase
      .from("public_user_directory")
      .select("user_email,last_active,run_count")
      .order("last_active", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        setDirectory(!error && data ? (data as DirectoryRow[]) : []);
      });

    supabase
      .from("public_tool_totals")
      .select("tool_name,call_count")
      .then(({ data, error }) => {
        if (!cancelled && !error && data) setToolTotals(data as ToolTotal[]);
      });

    supabase
      .from("public_skill_totals")
      .select("skill_name,call_count")
      .then(({ data, error }) => {
        if (!cancelled && !error && data) setSkillTotals(data as SkillTotal[]);
      });

    supabase
      .from("public_plugin_adoption")
      .select("plugin_name,user_count")
      .then(({ data, error }) => {
        if (!cancelled && !error && data) setPluginAdoption(data as PluginAdoption[]);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const mcpCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const { tool_name, call_count } of toolTotals) {
      const server = parseMcpServer(tool_name);
      if (server) counts[server] = (counts[server] ?? 0) + call_count;
    }
    return counts;
  }, [toolTotals]);
  const maxMcpCount = Math.max(1, ...topEntries(mcpCounts, 5).map(([, c]) => c));
  const mcpBars = topEntries(mcpCounts, 5).map(([name, count]) => ({ name, count, pct: (count / maxMcpCount) * 100 }));

  const skillCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const { skill_name, call_count } of skillTotals) counts[skill_name] = call_count;
    return counts;
  }, [skillTotals]);
  const maxSkillCount = Math.max(1, ...topEntries(skillCounts, 8).map(([, c]) => c));
  const skillBars = topEntries(skillCounts, 8).map(([name, count]) => ({ name, count, pct: (count / maxSkillCount) * 100 }));

  if (directory === null) return null;

  const totalUsers = directory.length;
  const totalRuns = directory.reduce((sum, r) => sum + r.run_count, 0);
  const totalMcpCalls = Object.values(mcpCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="profile-ds">
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: 32, display: "flex", flexDirection: "column", gap: 40 }}>
        <Card variant="tint">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <h1
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: "var(--weight-thin)",
                  fontSize: "var(--text-display-md)",
                  letterSpacing: "var(--tracking-display)",
                  color: "var(--text-strong)",
                }}
              >
                Glasshouse
              </h1>
              <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
                Public directory of how people use Claude Code
              </p>
            </div>
            <div style={{ display: "flex", gap: 36 }}>
              <StatBlock value={totalUsers} label="People sharing activity" />
              <StatBlock value={totalRuns} label="Total sessions" />
            </div>
          </div>
        </Card>

        <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 style={{ fontSize: "var(--text-h2)", fontWeight: "var(--weight-regular)" }}>People</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {directory.length === 0 && (
              <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No one has shared activity yet.</p>
            )}
            {directory.map((row) => (
              <Link
                key={row.user_email}
                href={`/profile/${encodeURIComponent(row.user_email)}`}
                style={{ textDecoration: "none" }}
              >
                <Card interactive>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                    <span style={{ fontSize: "var(--text-base)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>
                      {row.user_email}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <Badge tone="neutral">
                        {row.run_count} session{row.run_count === 1 ? "" : "s"}
                      </Badge>
                      <span style={eyebrowStyle}>{formatRelative(new Date(row.last_active).getTime())}</span>
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 style={{ fontSize: "var(--text-h2)", fontWeight: "var(--weight-regular)" }}>Site-wide activity</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24 }}>
            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="success">mcp</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  {totalMcpCalls} MCP calls across {Object.keys(mcpCounts).length} servers
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {mcpBars.length === 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No MCP activity recorded yet.</span>}
                  {mcpBars.map((bar) => (
                    <div key={bar.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{bar.name}</span>
                      <div
                        title={`${bar.count} call${bar.count === 1 ? "" : "s"}`}
                        style={{ height: 10, width: "100%", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)", overflow: "hidden" }}
                      >
                        <div style={{ height: "100%", borderRadius: "var(--radius-pill)", background: "var(--success)", width: `${bar.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="brand">skills</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                  {Object.values(skillCounts).reduce((a, b) => a + b, 0)} invocations across {Object.keys(skillCounts).length} skills
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {skillBars.length === 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No named skill invocations recorded yet.</span>}
                  {skillBars.map((bar) => (
                    <div key={bar.name} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: "var(--text-xs)", fontWeight: "var(--weight-bold)", color: "var(--text-strong)" }}>{bar.name}</span>
                      <div
                        title={`${bar.count} invocation${bar.count === 1 ? "" : "s"}`}
                        style={{ height: 10, width: "100%", borderRadius: "var(--radius-pill)", background: "var(--surface-sunken)", overflow: "hidden" }}
                      >
                        <div style={{ height: "100%", borderRadius: "var(--radius-pill)", background: "var(--lavender-500)", width: `${bar.pct}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card>
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <Badge tone="warning">plugins</Badge>
                <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>Always-on across the people above</p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {pluginAdoption.length === 0 && (
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-faint)" }}>No enabled plugins recorded yet.</span>
                  )}
                  {pluginAdoption.map((row) => (
                    <div key={row.plugin_name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>
                      <span>
                        {row.user_count} user{row.user_count === 1 ? "" : "s"} {row.user_count === 1 ? "has" : "have"}
                      </span>
                      <Tag>{row.plugin_name.split("@")[0]}</Tag>
                      <span>always-on</span>
                    </div>
                  ))}
                </div>
              </div>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
}
