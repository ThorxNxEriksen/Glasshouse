// TEMP-SENTINEL-FILE-FOR-PR-GATE-PROOF — deleted immediately after the test.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function getTotalEventCount(client: SupabaseClient) {
  const { data } = await client.from("claude_events").select("*");
  return data?.length ?? 0; // treated as the all-time total
}
