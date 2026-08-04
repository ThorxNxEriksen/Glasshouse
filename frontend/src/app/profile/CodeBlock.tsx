"use client";

// Faithful monospace viewer for captured claude.md text: one row per line,
// a right-aligned line-number gutter, and a copy button. Deliberately does
// not render markdown-to-HTML — this is a text viewer, not a renderer.
import { useState } from "react";

export function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const lines = text.split("\n");

  function handleCopy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      style={{
        position: "relative",
        borderRadius: "var(--radius-sm)",
        background: "var(--surface-sunken)",
        padding: "12px 14px",
        overflowX: "auto",
      }}
    >
      <button
        type="button"
        onClick={handleCopy}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          border: "none",
          borderRadius: "var(--radius-xs)",
          background: "var(--surface-card)",
          color: "var(--text-muted)",
          fontSize: "var(--text-2xs)",
          fontWeight: "var(--weight-bold)",
          padding: "4px 8px",
          cursor: "pointer",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: "flex", gap: 12 }}>
            <span
              style={{
                flex: "0 0 auto",
                width: "3ch",
                textAlign: "right",
                color: "var(--text-faint)",
                userSelect: "none",
              }}
            >
              {i + 1}
            </span>
            <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--text-body)" }}>{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
