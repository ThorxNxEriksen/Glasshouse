"use client";

import { useState } from "react";
import { getSupabaseClient, sendMagicLink } from "../../lib/supabaseClient";
import { useSupabaseSession } from "../../lib/useSupabaseSession";
import { ViewSection } from "../../components/ViewSection";

const VIEW_NAMES = [
  "claude_md_session",
  "session_hooks_installed",
  "permission_mode_summary",
  "session_tool_usage",
] as const;

export default function Home() {
  const { session, loaded } = useSupabaseSession();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("");

  async function handleSendMagicLink(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("Sending...");
    const { error } = await sendMagicLink(email);
    setStatus(error ? `Error: ${error.message}` : "Check your email for the magic link.");
  }

  async function handleSignOut() {
    await getSupabaseClient().auth.signOut();
  }

  if (!loaded) return null;

  if (!session) {
    return (
      <main>
        <h1>Glasshouse</h1>
        <form onSubmit={handleSendMagicLink}>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
          <button type="submit">Send magic link</button>
        </form>
        {status && <p>{status}</p>}
      </main>
    );
  }

  return (
    <main>
      <h1>Glasshouse</h1>
      <button onClick={handleSignOut}>Sign out</button>
      {VIEW_NAMES.map((viewName) => (
        <ViewSection key={viewName} viewName={viewName} />
      ))}
    </main>
  );
}
