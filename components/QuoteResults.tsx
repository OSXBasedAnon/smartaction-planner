"use client";

import type { QuoteItemResult } from "@/lib/types";

type QuoteResultsProps = {
  results: QuoteItemResult[];
};

export function QuoteResults({ results }: QuoteResultsProps) {
  if (results.length === 0) {
    return <p className="small">No results yet.</p>;
  }

  const statusHelp: Record<string, string> = {
    blocked: "Vendor anti-bot blocked automated access.",
    not_found: "No parsable price detected in returned HTML.",
    unsupported_js: "Vendor page requires JavaScript rendering.",
    error: "Request failed or timed out before parsing."
  };

  return (
    <div className="grid">
      <p className="small">Pricing may exclude shipping/tax. Site availability can be partial.</p>
      {results.map((item) => (
        <div key={item.query} className="panel result-card">
          <h3>{item.query}</h3>
          {item.best ? (
            <p className="ok">
              Best: {item.best.site} ${item.best.price.toFixed(2)}
            </p>
          ) : (
            <p className="small">No best price yet.</p>
          )}
          <div className="vendor-list">
            {item.matches.map((match, index) => (
              <article key={`${match.site}-${index}`} className="vendor-row">
                <div className="vendor-main">
                  <div className="row">
                    <strong>{match.site}</strong>
                    <span className={`status-pill status-${match.status}`}>{match.status}</span>
                  </div>
                  <div className="small vendor-title">{match.title || `Search results for "${item.query}"`}</div>
                  <div className="small">{statusHelp[match.status] ?? ""}</div>
                  {match.message ? <div className="error">{match.message}</div> : null}
                  {typeof match.latency_ms === "number" ? <div className="small">{match.latency_ms}ms</div> : null}
                </div>
                <div className="vendor-side">
                  {typeof match.price === "number" ? <div className="vendor-price">${match.price.toFixed(2)}</div> : <div className="small">n/a</div>}
                  {match.url ? (
                    <a href={match.url} target="_blank" rel="noreferrer">
                      Open result
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
