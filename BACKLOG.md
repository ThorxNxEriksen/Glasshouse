# Backlog

Things deliberately not built yet. Each entry says why it was deferred and what
would justify picking it up. Carried over from the original `PLAN.md` (removed
2026-08-04 — its design sections were all implemented; see git history for the
full original plan).

## Authentication (planned)

Intended, not merely deferred — Thor plans to add sign-in at some point. Scope is
not yet decided; what follows is what already exists to build on and the one
constraint that must hold.

**The public dashboard stays public.** Auth is additive. It must not become a
reason to re-gate the existing public views — `CLAUDE.md` is explicit that no login
standing between a visitor and the dashboard is the product, not an oversight.
Whatever sign-in unlocks, it is a layer *beside* the public surface, not in front
of it.

**Scaffolding already in the tree, deliberately kept:**

- `schema.sql` still defines the original `authenticated`-gated views —
  `claude_md_session`, `session_hooks_installed`, `permission_mode_summary`,
  `session_tool_usage`, `session_skill_usage` — each `GRANT SELECT ... TO
  authenticated`. Built, granted, currently read by nothing. This is the private
  read layer, waiting for a consumer.
- `frontend/lib/supabaseClient.ts` → `sendMagicLink()` (Supabase `signInWithOtp`,
  with a hard-won comment about `emailRedirectTo` and the Site URL fallback).
- `frontend/lib/useSupabaseSession.ts`.

Both frontend files are unreferenced by any page. **Do not delete them as dead
code** — they are the starting point for this work, and the redirect-URL comment
records a bug that already cost a debugging session.

**Undecided:** what sign-in is actually *for*. Candidates include an owner-only
view of your own data beyond what you published, a consent-management UI (change
per-repo answers without re-running the CLI), and the retroactive visibility
controls below — which need an identity to attach to and are largely blocked on
this. Pick the purpose before building the flow; the auth mechanism itself is
already solved.

## Per-user retroactive visibility controls

Letting a contributor hide their own already-sent sessions after the fact, beyond
the per-repo consent decision made before anything is sent.

Deferred because consent already prevents unwanted data from leaving a machine in
the first place. Pick up if someone wants to withdraw data they previously agreed
to share — which is a plausible ask now that the dashboard is public and profiles
are browsable by email.

Largely blocked on authentication above: withdrawing your own rows requires proving
which rows are yours.

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
