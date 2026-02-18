use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use futures::stream::{self, StreamExt};
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use tokio::time::{Duration, timeout};
use urlencoding::encode;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteItem {
    pub query: String,
    pub qty: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteOptions {
    pub cache_ttl: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteRequest {
    pub run_id: Option<String>,
    pub items: Vec<QuoteItem>,
    pub category: String,
    pub site_plan: Vec<String>,
    pub options: Option<QuoteOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteMatch {
    pub site: String,
    pub title: Option<String>,
    pub price: Option<f64>,
    pub currency: Option<String>,
    pub url: Option<String>,
    pub status: String,
    pub message: Option<String>,
    pub latency_ms: Option<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BestMatch {
    pub site: String,
    pub price: f64,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ItemResult {
    pub query: String,
    pub matches: Vec<SiteMatch>,
    pub best: Option<BestMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteResponse {
    pub run_id: String,
    pub started_at: String,
    pub duration_ms: u128,
    pub items: Vec<ItemResult>,
}

fn extract_price_from_body(body: &str) -> Option<f64> {
    let price_regex = Regex::new(r"\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)").ok()?;
    let lower = body.to_lowercase();
    let mut candidates: Vec<f64> = Vec::new();

    for caps in price_regex.captures_iter(body).take(60) {
        let Some(full_match) = caps.get(0) else {
            continue;
        };
        let Some(raw_num) = caps.get(1).map(|m| m.as_str().replace(',', "")) else {
            continue;
        };
        let Ok(price) = raw_num.parse::<f64>() else {
            continue;
        };
        if !(1.0..=50000.0).contains(&price) {
            continue;
        }

        let ctx_start = full_match.start().saturating_sub(24);
        let ctx_end = (full_match.end() + 24).min(lower.len());
        let context = &lower[ctx_start..ctx_end];
        if context.contains("/mo")
            || context.contains("month")
            || context.contains("monthly")
            || context.contains("financing")
            || context.contains("per wk")
            || context.contains("weekly")
        {
            continue;
        }

        if context.contains("shipping") && price < 20.0 {
            continue;
        }

        candidates.push(price);
    }

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = candidates[candidates.len() / 2];
    candidates
        .into_iter()
        .find(|price| *price >= median * 0.35)
        .or(Some(median))
}

fn build_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"));
    headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers
}

fn site_url(site: &str, query: &str) -> String {
    let q = encode(query);
    match site {
        "amazon" | "amazon_business" => format!("https://www.amazon.com/s?k={q}"),
        "bestbuy" => format!("https://www.bestbuy.com/site/searchpage.jsp?st={q}"),
        "newegg" => format!("https://www.newegg.com/p/pl?d={q}"),
        "bhphotovideo" => format!("https://www.bhphotovideo.com/c/search?q={q}"),
        "walmart" | "walmart_business" => format!("https://www.walmart.com/search?q={q}"),
        "staples" => format!("https://www.staples.com/{q}/directory_{q}"),
        "officedepot" => format!("https://www.officedepot.com/a/search/?q={q}"),
        "quill" => format!("https://www.quill.com/search?keywords={q}"),
        "webstaurantstore" => format!("https://www.webstaurantstore.com/search/{q}.html"),
        "katom" => format!("https://www.katom.com/search.html?query={q}"),
        "centralrestaurant" => format!("https://www.centralrestaurant.com/search/{q}"),
        "therestaurantstore" => format!("https://www.therestaurantstore.com/search/{q}"),
        "restaurantdepot" => format!("https://www.restaurantdepot.com/catalogsearch/result/?q={q}"),
        "grainger" => format!("https://www.grainger.com/search?searchQuery={q}"),
        "zoro" => format!("https://www.zoro.com/search?q={q}"),
        "homedepot" => format!("https://www.homedepot.com/s/{q}"),
        "platt" => format!("https://www.platt.com/search.aspx?q={q}"),
        "cityelectricsupply" => format!("https://www.cityelectricsupply.com/search?text={q}"),
        _ => format!("https://www.google.com/search?q={q}+buy")
    }
}

fn query_hash(query: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(query.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn ttl_seconds(req: &QuoteRequest) -> u64 {
    if let Some(options) = &req.options {
        if let Some(ttl) = options.cache_ttl {
            return ttl;
        }
    }
    std::env::var("CACHE_TTL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

pub async fn maybe_get_cache(site: &str, query: &str, ttl: u64) -> Option<SiteMatch> {
    if ttl == 0 {
        return None;
    }

    let base = std::env::var("NEXT_PUBLIC_SUPABASE_URL").ok()?;
    let key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
        .ok()
        .or_else(|| std::env::var("SUPABASE_SECRET_KEY").ok())?;
    let hash = query_hash(query);
    let cache_key = format!("{site}:{hash}");

    let client = reqwest::Client::new();
    let url = format!(
        "{}/rest/v1/price_cache?select=payload,updated_at&key=eq.{}",
        base,
        encode(&cache_key)
    );

    let response = client
        .get(url)
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .ok()?;

    let rows = response.json::<Vec<serde_json::Value>>().await.ok()?;
    let row = rows.first()?;
    let updated_at = chrono::DateTime::parse_from_rfc3339(row.get("updated_at")?.as_str()?).ok()?;
    let age = chrono::Utc::now().signed_duration_since(updated_at.with_timezone(&chrono::Utc));
    if age.num_seconds() > ttl as i64 {
        return None;
    }

    serde_json::from_value(row.get("payload")?.clone()).ok()
}

pub async fn upsert_cache(site: &str, query: &str, payload: &SiteMatch) {
    let ttl = std::env::var("CACHE_TTL_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    if ttl == 0 {
        return;
    }

    let Some(base) = std::env::var("NEXT_PUBLIC_SUPABASE_URL").ok() else {
        return;
    };
    let Some(key) = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
        .ok()
        .or_else(|| std::env::var("SUPABASE_SECRET_KEY").ok())
    else {
        return;
    };

    let hash = query_hash(query);
    let cache_key = format!("{site}:{hash}");

    let row = json!({
        "key": cache_key,
        "site": site,
        "query_hash": hash,
        "payload": payload,
        "updated_at": chrono::Utc::now().to_rfc3339()
    });

    let client = reqwest::Client::new();
    let _ = client
        .post(format!("{}/rest/v1/price_cache", base))
        .header("apikey", &key)
        .header("Authorization", format!("Bearer {key}"))
        .header("Prefer", "resolution=merge-duplicates")
        .json(&row)
        .send()
        .await;
}

pub async fn scrape_site(site: &str, query: &str, ttl: u64) -> SiteMatch {
    let start = Instant::now();

    if let Some(cached) = maybe_get_cache(site, query, ttl).await {
        return SiteMatch {
            status: "cached".to_string(),
            latency_ms: Some(start.elapsed().as_millis()),
            ..cached
        };
    }

    let url = site_url(site, query);
    let client = match reqwest::Client::builder().default_headers(build_headers()).build() {
        Ok(c) => c,
        Err(error) => {
            return SiteMatch {
                site: site.to_string(),
                title: None,
                price: None,
                currency: Some("USD".to_string()),
                url: Some(url),
                status: "error".to_string(),
                message: Some(format!("client_init_failed: {error}")),
                latency_ms: Some(start.elapsed().as_millis())
            }
        }
    };

    let request_result = timeout(Duration::from_secs(7), client.get(&url).send()).await;
    let response = match request_result {
        Ok(Ok(res)) => res,
        Ok(Err(error)) => {
            return SiteMatch {
                site: site.to_string(),
                title: None,
                price: None,
                currency: Some("USD".to_string()),
                url: Some(url),
                status: "error".to_string(),
                message: Some(error.to_string()),
                latency_ms: Some(start.elapsed().as_millis())
            }
        }
        Err(_) => {
            return SiteMatch {
                site: site.to_string(),
                title: None,
                price: None,
                currency: Some("USD".to_string()),
                url: Some(url),
                status: "error".to_string(),
                message: Some("timeout".to_string()),
                latency_ms: Some(start.elapsed().as_millis())
            }
        }
    };

    if response.status().as_u16() == 403 || response.status().as_u16() == 429 {
        return SiteMatch {
            site: site.to_string(),
            title: None,
            price: None,
            currency: Some("USD".to_string()),
            url: Some(url),
            status: "blocked".to_string(),
            message: Some(format!("http_status_{}", response.status().as_u16())),
            latency_ms: Some(start.elapsed().as_millis())
        };
    }

    let body = match response.text().await {
        Ok(text) => text,
        Err(error) => {
            return SiteMatch {
                site: site.to_string(),
                title: None,
                price: None,
                currency: Some("USD".to_string()),
                url: Some(url),
                status: "error".to_string(),
                message: Some(error.to_string()),
                latency_ms: Some(start.elapsed().as_millis())
            }
        }
    };

    let lower = body.to_lowercase();
    if lower.contains("enable javascript") || lower.contains("captcha") {
        return SiteMatch {
            site: site.to_string(),
            title: None,
            price: None,
            currency: Some("USD".to_string()),
            url: Some(url),
            status: "unsupported_js".to_string(),
            message: Some("site requires browser execution or anti-bot challenge".to_string()),
            latency_ms: Some(start.elapsed().as_millis())
        };
    }

    let (title, price) = {
        let html = Html::parse_document(&body);
        let title_selector = Selector::parse("title").ok();
        let title = title_selector.and_then(|sel| {
            html.select(&sel)
                .next()
                .map(|node| node.text().collect::<Vec<_>>().join(" ").trim().to_string())
        });

        let price = extract_price_from_body(&body);
        (title, price)
    };

    let status = if price.is_some() { "ok" } else { "not_found" }.to_string();

    let result = SiteMatch {
        site: site.to_string(),
        title,
        price,
        currency: Some("USD".to_string()),
        url: Some(url),
        status,
        message: None,
        latency_ms: Some(start.elapsed().as_millis())
    };

    if matches!(result.status.as_str(), "ok" | "not_found") {
        upsert_cache(site, query, &result).await;
    }

    result
}

pub fn best_from_matches(matches: &[SiteMatch]) -> Option<BestMatch> {
    matches
        .iter()
        .filter_map(|entry| {
            if entry.status == "ok" {
                Some((entry.site.clone(), entry.price?, entry.url.clone()?))
            } else {
                None
            }
        })
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(site, price, url)| BestMatch { site, price, url })
}

pub async fn run_quote_collect(request: &QuoteRequest) -> Result<Vec<ItemResult>> {
    let ttl = ttl_seconds(request);
    let semaphore = Arc::new(Semaphore::new(20));

    let mut item_results = Vec::with_capacity(request.items.len());

    for item in &request.items {
        let tasks = request.site_plan.iter().cloned().map(|site| {
            let sem = semaphore.clone();
            let query = item.query.clone();
            async move {
                let _permit = sem.acquire_owned().await.expect("semaphore closed");
                let result = scrape_site(&site, &query, ttl).await;
                (site, result)
            }
        });

        let mut matches: Vec<SiteMatch> = stream::iter(tasks)
            .buffer_unordered(20)
            .then(|(_, result)| async move { result })
            .collect()
            .await;

        matches.sort_by(|a, b| a.site.cmp(&b.site));
        let best = best_from_matches(&matches);

        item_results.push(ItemResult {
            query: item.query.clone(),
            matches,
            best
        });
    }

    Ok(item_results)
}
