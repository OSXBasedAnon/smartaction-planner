"use client";

import Link from "next/link";
import { DragEvent, useMemo, useState } from "react";
import { QuoteResults } from "@/components/QuoteResults";
import { RuntimeTimer } from "@/components/RuntimeTimer";
import type { QuoteItemResult, SiteMatch } from "@/lib/types";

type StreamEvent =
  | { type: "started"; run_id: string }
  | { type: "match"; item_index: number; query: string; match: SiteMatch }
  | { type: "item_done"; item_index: number; query: string; best?: { site: string; price: number; url: string } }
  | { type: "done"; duration_ms: number }
  | { type: "error"; message: string };

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

  const items = useMemo(() => parseCsvLike(rawInput), [rawInput]);
  const inputType = useMemo(() => inferInputType(items), [items]);

  async function applyDroppedFile(file: File) {
    const text = await file.text();
    const parsed = parseCsvLike(text);
    setRawInput(parsed.map((item) => `${item.query},${item.qty}`).join("\n"));
  }

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Please drop a CSV file.");
      return;
    }
    await applyDroppedFile(file);
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
            if (event.type === "item_done" && event.best) {
              setResults((prev) => {
                const next = [...prev];
                while (next.length <= event.item_index) next.push({ query: event.query, matches: [] });
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
    <main className="home-wrap">
      <header className="home-nav">
        <div className="row" style={{ gap: 10 }}>
          <Link href="/app">Dashboard</Link>
          <Link href="/login">Login</Link>
          <Link href="/signup">Sign up</Link>
        </div>
      </header>

      <section className="search-shell panel">
        <div className="brand-row">
          <h1>SupplyFlare</h1>
          <img src="/logo.svg" alt="SupplyFlare logo" className="brand-logo" />
        </div>

        <p className="small">Type anything, paste CSV lines, or drag/drop a CSV file.</p>

        <div
          className="drop-zone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          onClick={() => document.getElementById("csv-file")?.click()}
        >
          <textarea
            value={rawInput}
            onChange={(event) => setRawInput(event.target.value)}
            placeholder="macbook pro 14 m3,1&#10;paper towels 2-ply,4&#10;SKU-ABC-123,2"
            rows={6}
          />
          <input
            id="csv-file"
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              await applyDroppedFile(file);
            }}
          />
          <span className="small">Drag CSV here or click to upload</span>
        </div>

        <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
          <button type="button" onClick={runQuote} disabled={running || items.length === 0}>
            Search
          </button>
          <RuntimeTimer running={running} finishedDurationMs={duration} />
        </div>

        <p className="disclaimer">Prices may exclude shipping and tax.</p>
        {runId ? <p className="small">Run ID: {runId}</p> : null}
        {error ? <p className="error">{error}</p> : null}
      </section>

      <section className="container panel" style={{ marginTop: 14 }}>
        <QuoteResults results={results} />
      </section>
    </main>
  );
}
