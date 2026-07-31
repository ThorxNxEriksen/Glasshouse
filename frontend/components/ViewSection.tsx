"use client";

import { useEffect, useState } from "react";
import { getSupabaseClient } from "../lib/supabaseClient";

export function ViewSection({ viewName }: { viewName: string }) {
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSupabaseClient()
      .from(viewName)
      .select("*")
      .limit(20)
      .then(({ data, error }) => {
        if (cancelled) return;
        setRows(!error && data && data.length > 0 ? data : []);
      });
    return () => {
      cancelled = true;
    };
  }, [viewName]);

  return (
    <section>
      <h2>{viewName}</h2>
      {rows === null || rows.length === 0 ? (
        <p>No data yet.</p>
      ) : (
        <pre>{JSON.stringify(rows, null, 2)}</pre>
      )}
    </section>
  );
}
