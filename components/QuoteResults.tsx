"use client";

import type { QuoteItemResult } from "@/lib/types";

type QuoteResultsProps = {
  results: QuoteItemResult[];
};

export function QuoteResults({ results }: QuoteResultsProps) {
  if (results.length === 0) {
    return <p className="small">No results yet.</p>;
  }

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
          <div className="vendor-grid">
            {item.matches.map((match, index) => (
              <div key={`${match.site}-${index}`} className="vendor-card">
                <strong>{match.site}</strong>
                <div className="small">status: {match.status}</div>
                {typeof match.price === "number" ? <div>${match.price.toFixed(2)}</div> : null}
                {match.url ? (
                  <a href={match.url} target="_blank" rel="noreferrer">
                    View listing
                  </a>
                ) : null}
                {match.message ? <div className="error">{match.message}</div> : null}
                {typeof match.latency_ms === "number" ? <div className="small">{match.latency_ms}ms</div> : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
