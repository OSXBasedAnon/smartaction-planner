"use client";

import Link from "next/link";
import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { QuoteResults } from "@/components/QuoteResults";
import { RuntimeTimer } from "@/components/RuntimeTimer";
import type { QuoteItemResult, SiteMatch } from "@/lib/types";

type StreamEvent =
  | { type: "started"; run_id: string }
  | { type: "match"; item_index: number; query: string; match: SiteMatch }
  | { type: "item_done"; item_index: number; query: string; best?: { site: string; price: number; url: string } }
  | { type: "done"; duration_ms: number }
  | { type: "error"; message: string };

type HistoryRun = {
  id: string;
  raw_input: string;
  created_at: string;
  status: string;
  duration_ms: number | null;
};

function rawInputFromRun(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Array<{ query?: string; qty?: number }>;
    if (!Array.isArray(parsed)) return raw;
    const lines = parsed
      .map((item) => `${(item.query ?? "").trim()},${Number.isFinite(item.qty) && (item.qty ?? 0) > 0 ? item.qty : 1}`)
      .filter((line) => !line.startsWith(","));
    return lines.length > 0 ? lines.join("\n") : raw;
  } catch {
    return raw;
  }
}

function mergeMatch(results: QuoteItemResult[], itemIndex: number, query: string, match: SiteMatch): QuoteItemResult[] {
  const next = [...results];
  while (next.length <= itemIndex) next.push({ query, matches: [] });

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

function parseCsvLike(text: string): Array<{ query: string; qty: number }> {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [query, qty] = line.split(",").map((part) => part.trim());
      return { query, qty: Number.isFinite(Number(qty)) && Number(qty) > 0 ? Number(qty) : 1 };
    })
    .filter((item) => item.query.length > 0);
}

function inferInputType(items: Array<{ query: string; qty: number }>): "text" | "sku" | "csv" {
  if (items.length > 1) return "csv";
  const q = items[0]?.query ?? "";
  const skuLike = /^[a-zA-Z0-9\-_]{4,}$/.test(q) && !q.includes(" ");
  return skuLike ? "sku" : "text";
}

export default function LandingPage() {
  const [rawInput, setRawInput] = useState("");
  const [results, setResults] = useState<QuoteItemResult[]>([]);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);
  const [historyRuns, setHistoryRuns] = useState<HistoryRun[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => parseCsvLike(rawInput), [rawInput]);
  const inputType = useMemo(() => inferInputType(items), [items]);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/me-history", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as { logged_in: boolean; runs: HistoryRun[] };
      setLoggedIn(data.logged_in);
      setHistoryRuns(data.runs ?? []);
    })();
  }, []);

  async function removeRun(runIdToDelete: string) {
    const response = await fetch("/api/me-history", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runIdToDelete })
    });
    if (!response.ok) return;
    setHistoryRuns((prev) => prev.filter((run) => run.id !== runIdToDelete));
  }

  async function applyFile(file: File) {
    const text = await file.text();
    const parsed = parseCsvLike(text);
    setRawInput(parsed.map((item) => `${item.query},${item.qty}`).join("\n"));
  }

  async function onDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please drop a CSV file.");
      return;
    }
    await applyFile(file);
  }

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
            if (event.type === "match") setResults((prev) => mergeMatch(prev, event.item_index, event.query, event.match));
            if (event.type === "item_done") {
              setResults((prev) => {
                const next = [...prev];
                while (next.length <= event.item_index) next.push({ query: event.query, matches: [] });
                if (event.best) {
                  next[event.item_index].best = event.best;
                }
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
    <main className="home-wrap">
      <header className="home-nav">
        <div className="row" style={{ gap: 10 }}>
          {loggedIn ? (
            <details className="history-menu">
              <summary>History</summary>
              <div className="history-dropdown">
                {historyRuns.length === 0 ? <p className="small">No runs yet</p> : null}
                {historyRuns.map((run) => (
                  <div key={run.id} className="history-item">
                    <button type="button" className="history-fill" onClick={() => setRawInput(rawInputFromRun(run.raw_input))} title="Load into search">
                      <span>{run.raw_input.slice(0, 42)}</span>
                      <span className="small">{run.status}</span>
                    </button>
                    <button type="button" className="history-delete" onClick={() => void removeRun(run.id)} aria-label="Delete run">
                      X
                    </button>
                  </div>
                ))}
              </div>
            </details>
          ) : (
            <>
              <Link href="/login">Login</Link>
              <Link href="/signup">Sign up</Link>
            </>
          )}
        </div>
      </header>

      <section className="search-shell no-card">
        <div className="brand-row">
          <h1>SupplyFlare</h1>
          <img src="/logo.svg" alt="SupplyFlare logo" className="brand-logo" />
          <span className="beta-badge">beta</span>
        </div>

        <form
          className="search-line"
          onSubmit={(event) => {
            event.preventDefault();
            void runQuote();
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
        >
          <input
            value={rawInput}
            onChange={(event) => setRawInput(event.target.value)}
            placeholder="Type anything or drop a CSV"
            aria-label="Search input"
          />
          <button
            type="button"
            className="attach-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach CSV"
            aria-label="Attach CSV"
          >
            +CSV
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              await applyFile(file);
            }}
          />
          <button type="submit" className="search-btn" disabled={running || items.length === 0}>
            Search
          </button>
        </form>

        <div className="row" style={{ justifyContent: "center", marginTop: 10 }}>
          <RuntimeTimer running={running} finishedDurationMs={duration} />
        </div>

        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="container results-flat" style={{ marginTop: 14 }}>
        <QuoteResults results={results} />
      </section>

      <section className="container meta-strip">
        <p className="small">Pricing may exclude shipping/tax. Site availability can be partial.</p>
        {runId ? <p className="small">Run ID: {runId}</p> : null}
      </section>
    </main>
  );
}
