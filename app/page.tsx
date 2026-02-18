"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CSVUploader } from "@/components/CSVUploader";
import { QuoteResults } from "@/components/QuoteResults";
import { RuntimeTimer } from "@/components/RuntimeTimer";
import { SearchInput } from "@/components/SearchInput";
import type { QuoteItemResult, SiteMatch } from "@/lib/types";

type StreamEvent =
  | { type: "started"; run_id: string }
  | { type: "match"; item_index: number; query: string; match: SiteMatch }
  | { type: "item_done"; item_index: number; query: string; best?: { site: string; price: number; url: string } }
  | { type: "done"; duration_ms: number }
  | { type: "error"; message: string };

function mergeMatch(results: QuoteItemResult[], itemIndex: number, query: string, match: SiteMatch): QuoteItemResult[] {
  const next = [...results];
  while (next.length <= itemIndex) {
    next.push({ query, matches: [] });
  }
  const current = next[itemIndex];
  current.query = query;
  current.matches = [...current.matches, match];

  const bestMatch = current.matches
    .filter((entry) => entry.status === "ok" && typeof entry.price === "number" && entry.url)
    .sort((a, b) => (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER))[0];

  if (bestMatch?.price && bestMatch.url) {
    current.best = { site: bestMatch.site, price: bestMatch.price, url: bestMatch.url };
  }

  return next;
}

export default function LandingPage() {
  const [items, setItems] = useState<Array<{ query: string; qty: number }>>([]);
  const [results, setResults] = useState<QuoteItemResult[]>([]);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const inputType = useMemo(() => (items.length > 1 ? "csv" : "text"), [items.length]);

  async function runQuote() {
    if (items.length === 0) return;
    setRunning(true);
    setError(null);
    setResults([]);
    setDuration(undefined);
    setRunId(null);

    try {
      const response = await fetch("/api/run-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, input_type: inputType })
      });

      if (!response.ok || !response.body) {
        throw new Error(`Run failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");

        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line.length > 0) {
            const event: StreamEvent = JSON.parse(line);
            if (event.type === "started") setRunId(event.run_id);
            if (event.type === "match") {
              setResults((prev) => mergeMatch(prev, event.item_index, event.query, event.match));
            }
            if (event.type === "item_done" && event.best) {
              setResults((prev) => {
                const next = [...prev];
                while (next.length <= event.item_index) {
                  next.push({ query: event.query, matches: [] });
                }
                next[event.item_index].best = event.best;
                return next;
              });
            }
            if (event.type === "done") setDuration(event.duration_ms);
            if (event.type === "error") setError(event.message);
          }

          newlineIndex = buffer.indexOf("\n");
        }
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Unknown run error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="container grid" style={{ gap: 16 }}>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>SupplyFlare</h1>
          <p className="small">High-speed quote discovery across multiple vendors</p>
        </div>
        <div className="row">
          <Link href="/app">Dashboard</Link>
          <Link href="/login">Login</Link>
          <Link href="/signup">Sign up</Link>
        </div>
      </header>

      <section className="panel grid" style={{ gap: 14 }}>
        <SearchInput onItems={setItems} />
        <CSVUploader onItems={setItems} />
        <div className="row">
          <button type="button" onClick={runQuote} disabled={running || items.length === 0}>
            Run Quote
          </button>
          <RuntimeTimer running={running} finishedDurationMs={duration} />
        </div>
        {runId ? <p className="small">Run ID: {runId}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="panel">
        <QuoteResults results={results} />
      </section>
    </main>
  );
}
