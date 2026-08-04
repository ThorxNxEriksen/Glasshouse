# Backlog

Things deliberately not built yet. Each entry says why it was deferred and what
would justify picking it up. Carried over from the original `PLAN.md` (removed
2026-08-04 — its design sections were all implemented; see git history for the
full original plan).

## Per-user retroactive visibility controls

Letting a contributor hide their own already-sent sessions after the fact, beyond
the per-repo consent decision made before anything is sent.

Deferred because consent already prevents unwanted data from leaving a machine in
the first place. Pick up if someone wants to withdraw data they previously agreed
to share — which is a plausible ask now that the dashboard is public and profiles
are browsable by email.

## Smarter CLAUDE.md redaction

`redacted` share level is headings-only plus a line/char count. That is a
structural summary, not PII-grade scrubbing.

Known ceiling, documented as such. Upgrade to secret/PII-pattern scrubbing only if
headings-only proves either too thin to be useful or too revealing.

## Local buffering / retry queue for hook POSTs

Hook POSTs go straight to PostgREST with a short abort timeout. Offline or failed
sends are dropped silently — a missed row is just a missed row.

Deferred because a failed POST must never interrupt a real session, and a retry
queue is meaningfully more machinery than the data is worth. Pick up only if gaps
turn out to distort the dashboard.

## OTel Collector

Not used. Hooks POST directly to PostgREST.

Remains a documented alternative only if hook-based permission-mode diffing proves
too coarse.

## Per-session work-type classification

Bucket each session as build feature / debug fix / improve quality / analyze data /
plan design / prototype / write docs. Taxonomy borrowed from Claude Code's built-in
`/team-onboarding` command.

That command classifies by feeding each session's *first user message* to the
model. Glasshouse cannot copy that: free-text prompts are exactly what
`sanitizeRaw` refuses to transmit, and a label inferred from text we never
published is not covered by any existing consent category.

The version that fits is a SQL view over the `tool_name` sequence already in
`claude_events` — Edit/Write-heavy → build, Read/Grep with no writes → plan
design, repeated Read→Edit on one file → debug fix. Ceiling: tool-mix is a weak
proxy and will misread sessions that plan first and build second. Pick up if the
buckets prove informative enough to be worth showing; drop the idea if they read
as noise.
