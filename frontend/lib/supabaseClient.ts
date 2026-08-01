import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Lazy singleton: createClient() throws if the URL/key are empty, so it must
// only run in the browser (never at module import time, which is what
// `next build`'s static prerender pass would otherwise trigger with no
// .env.local present).
let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ""
    );
  }
  return client;
}
