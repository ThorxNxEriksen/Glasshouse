// Thin ports of the Intellishore design-system primitives this page uses
// (Badge/Button/Card/StatBlock/Tag/Avatar), matching the class-name/markup
// contract from _ds_bundle.js so ds.css renders them identically to the
// Claude Design mock. Scoped to this route — see ds.css for why.
import type { ReactNode, MouseEventHandler, CSSProperties } from "react";

function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "brand" | "accent" | "success" | "warning" | "solid";
}) {
  return <span className={cx("is-badge", `is-badge--${tone}`)}>{children}</span>;
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  onClick,
}: {
  children: ReactNode;
  variant?: "primary" | "ghost";
  size?: "md" | "sm";
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      className={cx("is-btn", `is-btn--${variant}`, size === "sm" && "is-btn--sm")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  variant,
  interactive = false,
  onClick,
  style,
}: {
  children: ReactNode;
  variant?: "tint";
  interactive?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cx("is-card", variant && `is-card--${variant}`, interactive && "is-card--interactive")}
      onClick={onClick}
      style={style}
    >
      {children}
    </div>
  );
}

export function StatBlock({ value, label }: { value: ReactNode; label: string }) {
  return (
    <div className="is-stat">
      <span className="is-stat__value">{value}</span>
      <span className="is-stat__label">{label}</span>
    </div>
  );
}

export function Tag({ children, onClick }: { children: ReactNode; onClick?: MouseEventHandler<HTMLSpanElement> }) {
  return (
    <span className={cx("is-tag", onClick && "is-tag--interactive")} onClick={onClick}>
      {children}
    </span>
  );
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("");
}

export function Avatar({ name, size }: { name: string; size?: "lg" }) {
  return (
    <span className={cx("is-avatar", size === "lg" && "is-avatar--lg")} title={name}>
      {initials(name)}
    </span>
  );
}
