"use client";

import type { QuoteItemResult } from "@/lib/types";
import { getVendorSearchUrl } from "@/lib/vendor-links";

type QuoteResultsProps = {
  results: QuoteItemResult[];
  runId?: string | null;
};

function normalizeDestination(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function isSameDestination(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return normalizeDestination(a) === normalizeDestination(b);
}

function isListingUrl(url?: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("/search") ||
    lower.includes("search?") ||
    lower.includes("/s?") ||
    lower.includes("/catalogsearch/") ||
    lower.includes("/sch/i.html") ||
    lower.includes("/p/pl?d=")
  );
}

function trackHref(params: { target: string; site: string; action: "open_result" | "open_listing"; runId?: string | null; query: string }) {
  const q = new URLSearchParams();
  q.set("target", params.target);
  q.set("site", params.site);
  q.set("action", params.action);
  q.set("query", params.query);
  if (params.runId) q.set("run_id", params.runId);
  return `/api/track-click?${q.toString()}`;
}

export function QuoteResults({ results, runId }: QuoteResultsProps) {
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
      {results.map((item) => (
        <div key={item.query} className="panel result-card">
          <h3>{item.query}</h3>
          {item.best ? (
            <p className="ok">
              Best:{" "}
              <a className="best-link" href={item.best.url} target="_blank" rel="noreferrer">
                {item.best.site} {isListingUrl(item.best.url) ? `From $${item.best.price.toFixed(2)}` : `$${item.best.price.toFixed(2)}`}
              </a>
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
                  {typeof match.price === "number" ? (
                    <div className="vendor-price">{isListingUrl(match.url) ? `From $${match.price.toFixed(2)}` : `$${match.price.toFixed(2)}`}</div>
                  ) : (
                    <div className="small">n/a</div>
                  )}
                  {match.url && match.status === "ok" && !isSameDestination(match.url, getVendorSearchUrl(match.site, item.query)) ? (
                    <a
                      href={trackHref({ target: match.url, site: match.site, action: "open_result", runId, query: item.query })}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open result
                    </a>
                  ) : null}
                  <a
                    href={trackHref({
                      target: getVendorSearchUrl(match.site, item.query),
                      site: match.site,
                      action: "open_listing",
                      runId,
                      query: item.query
                    })}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open listing
                  </a>
                </div>
              </article>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
