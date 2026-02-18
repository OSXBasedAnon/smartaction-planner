export type Category = "office" | "electronics" | "restaurant" | "electrical" | "unknown";

export type QuoteItem = {
  query: string;
  qty: number;
};

export type SiteMatch = {
  site: string;
  title?: string;
  price?: number;
  currency?: string;
  url?: string;
  status: "ok" | "blocked" | "not_found" | "error" | "unsupported_js" | "cached";
  message?: string;
  latency_ms?: number;
};

export type QuoteItemResult = {
  query: string;
  matches: SiteMatch[];
  best?: {
    site: string;
    price: number;
    url: string;
  };
};
