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

// Without an explicit emailRedirectTo, Supabase sends every magic link to the
// project's Site URL -- one single value, which defaults to
// http://localhost:3000. That is why links from production landed on
// localhost. Pinning Site URL to production alone would just invert the bug
// and break local development, so send the user back to wherever they
// actually asked to sign in from: origin keeps dev/preview/production
// working off one config, and pathname returns them to wherever they were
// (e.g. / or /profile/<email>) rather than always the root.
//
// Supabase only honours this if the URL matches the Redirect URLs allow list
// (Auth -> URL Configuration); anything else silently falls back to Site URL.
// Browser-only, so it must stay inside an event handler -- window does not
// exist during `next build`'s prerender pass.
export function sendMagicLink(email: string) {
  return getSupabaseClient().auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
}
