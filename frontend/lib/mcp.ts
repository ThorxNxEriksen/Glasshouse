export function parseMcpServer(toolName: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(toolName);
  if (!m) return null;
  return m[1].replace(/^claude_ai_/, "").replace(/_/g, " ");
}
