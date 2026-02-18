use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use futures::stream::{self, StreamExt};
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
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
    pub site_overrides: Option<HashMap<String, String>>,
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

fn parse_price(raw: &str) -> Option<f64> {
    raw.replace(',', "").parse::<f64>().ok()
}

fn extract_title(body: &str) -> Option<String> {
    let title_re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").ok()?;
    let raw = title_re.captures(body)?.get(1)?.as_str();
    let compact = raw
        .replace('\n', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact)
    }
}

const USER_AGENTS: [&str; 5] = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13.6; rv:123.0) Gecko/20100101 Firefox/123.0"
];

fn pick_user_agent(site: &str, query: &str, attempt: usize) -> &'static str {
    let mut seed: usize = attempt;
    for byte in site.bytes().chain(query.bytes()) {
        seed = seed.wrapping_mul(131).wrapping_add(byte as usize);
    }
    USER_AGENTS[seed % USER_AGENTS.len()]
}

fn likely_bot_challenge(lower_body: &str) -> bool {
    lower_body.contains("enable javascript")
        || lower_body.contains("captcha")
        || lower_body.contains("pardon our interruption")
        || lower_body.contains("are you a human")
        || lower_body.contains("cloudflare")
        || lower_body.contains("access denied")
        || lower_body.contains("bot detection")
}

async fn read_body_limited(response: reqwest::Response, max_bytes: usize) -> Result<String, String> {
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let slice = if bytes.len() > max_bytes {
        &bytes[..max_bytes]
    } else {
        &bytes
    };
    Ok(String::from_utf8_lossy(slice).to_string())
}

fn first_capture(body: &str, pattern: &str) -> Option<String> {
    let re = Regex::new(pattern).ok()?;
    re.captures(body)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn extract_result_url(site: &str, body: &str) -> Option<String> {
    match site {
        "amazon" | "amazon_business" => {
            let path = first_capture(body, r#"href=\"(/(?:gp|dp|[^"]*?/dp/)[^"]+)\""#)?;
            Some(format!("https://www.amazon.com{}", path.replace("\\u0026", "&")))
        }
        "newegg" => first_capture(body, r#"href=\"(https://www\.newegg\.com/p/[^\"]+)\""#),
        "bestbuy" => {
            let path = first_capture(body, r#"href=\"(/site/[^"]+\.p\?[^"]*)\""#)
                .or_else(|| first_capture(body, r#"href=\"(/site/[^"]+\.p)\""#))?;
            Some(format!("https://www.bestbuy.com{}", path.replace("\\u0026", "&")))
        }
        "ebay" => first_capture(body, r#"href=\"(https://www\.ebay\.com/itm/[^\"]+)\""#),
        "target" => first_capture(body, r#"href=\"(https://www\.target\.com/p/[^\"]+)\""#),
        _ => None
    }
}

fn extract_price_from_json_ld(body: &str) -> Option<f64> {
    let price_re = Regex::new(r#""price"\s*:\s*"?(?P<p>[0-9]+(?:\.[0-9]{1,2})?)"?"#).ok()?;
    let mut prices = Vec::new();
    for caps in price_re.captures_iter(body).take(80) {
        let Some(raw) = caps.name("p").map(|m| m.as_str()) else {
            continue;
        };
        let Some(price) = parse_price(raw) else {
            continue;
        };
        if (3.0..=50000.0).contains(&price) {
            prices.push(price);
        }
    }
    if prices.is_empty() {
        return None;
    }
    prices.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(prices[prices.len() / 2])
}

fn extract_amazon_price(body: &str) -> Option<f64> {
    let whole_re = Regex::new(r#"a-price-whole">([0-9,]{1,12})<"#).ok()?;
    let frac_re = Regex::new(r#"a-price-fraction">([0-9]{2})<"#).ok()?;
    let mut candidates = Vec::new();

    for whole in whole_re.captures_iter(body).take(20) {
        let Some(w) = whole.get(1).map(|m| m.as_str()) else {
            continue;
        };
        if let Some(base) = parse_price(w) {
            if (5.0..=50000.0).contains(&base) {
                candidates.push(base);
            }
        }
    }

    for pair in whole_re
        .captures_iter(body)
        .zip(frac_re.captures_iter(body))
        .take(20)
    {
        let (whole, frac) = pair;
        let Some(w) = whole.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Some(f) = frac.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let joined = format!("{}.{}", w.replace(',', ""), f);
        if let Ok(price) = joined.parse::<f64>() {
            if (5.0..=50000.0).contains(&price) {
                candidates.push(price);
            }
        }
    }

    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(candidates[candidates.len() / 2])
}

fn extract_price_from_body(site: &str, body: &str) -> Option<f64> {
    if let Some(json_ld_price) = extract_price_from_json_ld(body) {
        return Some(json_ld_price);
    }

    if matches!(site, "amazon" | "amazon_business") {
        if let Some(price) = extract_amazon_price(body) {
            return Some(price);
        }
    }

    let price_regex = Regex::new(r"\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)").ok()?;
    let lower = body.to_lowercase();
    let mut candidates: Vec<f64> = Vec::new();

    for caps in price_regex.captures_iter(body).take(60) {
        let Some(full_match) = caps.get(0) else {
            continue;
        };
        let Some(raw_num) = caps.get(1).map(|m| m.as_str()) else {
            continue;
        };
        let Some(price) = parse_price(raw_num) else {
            continue;
        };
        if !(3.0..=50000.0).contains(&price) {
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

        if price < 10.0 && !raw_num.contains('.') {
            continue;
        }

        candidates.push(price);
    }

    if candidates.is_empty() {
        return None;
    }

    candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = candidates[candidates.len() / 2];
    candidates.into_iter().find(|price| *price >= median * 0.35).or(Some(median))
}

fn build_headers_with_ua(user_agent: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(user_agent) {
        headers.insert(USER_AGENT, value);
    } else {
        headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENTS[0]));
    }
    headers.insert(ACCEPT, HeaderValue::from_static("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    headers.insert("sec-fetch-dest", HeaderValue::from_static("document"));
    headers.insert("sec-fetch-mode", HeaderValue::from_static("navigate"));
    headers.insert("sec-fetch-site", HeaderValue::from_static("none"));
    headers
}

fn site_url(site: &str, query: &str, overrides: Option<&HashMap<String, String>>) -> String {
    let q = encode(query);
    if let Some(map) = overrides {
        if let Some(template) = map.get(site) {
            return template.replace("{q}", &q);
        }
    }
    match site {
        "amazon" | "amazon_business" => format!("https://www.amazon.com/s?k={q}"),
        "bestbuy" => format!("https://www.bestbuy.com/site/searchpage.jsp?st={q}"),
        "newegg" => format!("https://www.newegg.com/p/pl?d={q}"),
        "bhphotovideo" => format!("https://www.bhphotovideo.com/c/search?q={q}"),
        "walmart" | "walmart_business" => format!("https://www.walmart.com/search?q={q}"),
        "staples" => format!("https://www.staples.com/{q}/directory_{q}"),
        "officedepot" => format!("https://www.officedepot.com/a/search/?q={q}"),
        "quill" => format!("https://www.quill.com/search?keywords={q}"),
        "uline" => format!("https://www.uline.com/BL_35/Search?keywords={q}"),
        "target" => format!("https://www.target.com/s?searchTerm={q}"),
        "webstaurantstore" => format!("https://www.webstaurantstore.com/search/{q}.html"),
        "katom" => format!("https://www.katom.com/search.html?query={q}"),
        "centralrestaurant" => format!("https://www.centralrestaurant.com/search/{q}"),
        "therestaurantstore" => format!("https://www.therestaurantstore.com/search/{q}"),
        "restaurantdepot" => format!("https://www.restaurantdepot.com/catalogsearch/result/?q={q}"),
        "ace_mart" => format!("https://www.acemart.com/search?q={q}"),
        "grainger" => format!("https://www.grainger.com/search?searchQuery={q}"),
        "zoro" => format!("https://www.zoro.com/search?q={q}"),
        "homedepot" => format!("https://www.homedepot.com/s/{q}"),
        "platt" => format!("https://www.platt.com/search.aspx?q={q}"),
        "cityelectricsupply" => format!("https://www.cityelectricsupply.com/search?text={q}"),
        "lowes" => format!("https://www.lowes.com/search?searchTerm={q}"),
        "mcmaster" => format!("https://www.mcmaster.com/products/{q}/"),
        "adorama" => format!("https://www.adorama.com/l/?searchinfo={q}"),
        "microcenter" => format!("https://www.microcenter.com/search/search_results.aspx?Ntt={q}"),
        "ebay" => format!("https://www.ebay.com/sch/i.html?_nkw={q}"),
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

pub async fn scrape_site(site: &str, query: &str, ttl: u64, overrides: Option<&HashMap<String, String>>) -> SiteMatch {
    let start = Instant::now();

    if let Some(cached) = maybe_get_cache(site, query, ttl).await {
        return SiteMatch {
            status: "cached".to_string(),
            latency_ms: Some(start.elapsed().as_millis()),
            ..cached
        };
    }

    let url = site_url(site, query, overrides);
    let mut last_message = None::<String>;
    let mut final_body = None::<String>;
    let mut final_status = None::<u16>;

    for attempt in 0..2usize {
        let ua = pick_user_agent(site, query, attempt);
        let client = match reqwest::Client::builder().default_headers(build_headers_with_ua(ua)).build() {
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

        let timeout_secs = if attempt == 0 { 5 } else { 3 };
        let request_result = timeout(Duration::from_secs(timeout_secs), client.get(&url).send()).await;
        let response = match request_result {
            Ok(Ok(res)) => res,
            Ok(Err(error)) => {
                last_message = Some(error.to_string());
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                break;
            }
            Err(_) => {
                last_message = Some("timeout".to_string());
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    continue;
                }
                break;
            }
        };

        let status = response.status().as_u16();
        final_status = Some(status);
        if status == 403 || status == 429 || status == 503 {
            last_message = Some(format!("http_status_{status}"));
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
            break;
        }

        let body = match read_body_limited(response, 512 * 1024).await {
            Ok(text) => text,
            Err(error) => {
                last_message = Some(error);
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                }
                break;
            }
        };

        if likely_bot_challenge(&body.to_lowercase()) {
            last_message = Some("challenge_detected".to_string());
            if attempt == 0 {
                tokio::time::sleep(Duration::from_millis(300)).await;
                continue;
            }
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

        final_body = Some(body);
        break;
    }

    let body = if let Some(body) = final_body {
        body
    } else if matches!(final_status, Some(403 | 429 | 503)) || matches!(last_message.as_deref(), Some("challenge_detected")) {
        return SiteMatch {
            site: site.to_string(),
            title: None,
            price: None,
            currency: Some("USD".to_string()),
            url: Some(url),
            status: "blocked".to_string(),
            message: last_message.or_else(|| final_status.map(|s| format!("http_status_{s}"))),
            latency_ms: Some(start.elapsed().as_millis())
        };
    } else {
        return SiteMatch {
            site: site.to_string(),
            title: None,
            price: None,
            currency: Some("USD".to_string()),
            url: Some(url),
            status: "error".to_string(),
            message: last_message.or(Some("request_failed".to_string())),
            latency_ms: Some(start.elapsed().as_millis())
        };
    };

    let title = extract_title(&body);
    let price = extract_price_from_body(site, &body);
    let result_url = extract_result_url(site, &body);

    let status = if price.is_some() { "ok" } else { "not_found" }.to_string();

    let result = SiteMatch {
        site: site.to_string(),
        title,
        price,
        currency: Some("USD".to_string()),
        url: result_url.or(Some(url)),
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
    let valid: Vec<(String, f64, String)> = matches
        .iter()
        .filter_map(|entry| {
            if entry.status == "ok" {
                Some((entry.site.clone(), entry.price?, entry.url.clone()?))
            } else {
                None
            }
        })
        .collect();

    if valid.is_empty() {
        return None;
    }

    let mut prices: Vec<f64> = valid.iter().map(|(_, p, _)| *p).collect();
    prices.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let filtered: Vec<(String, f64, String)> = if prices.len() >= 3 {
        let median = prices[prices.len() / 2];
        let floor = median * 0.4;
        let kept: Vec<(String, f64, String)> = valid
            .iter()
            .filter(|(_, price, _)| *price >= floor)
            .cloned()
            .collect();
        if kept.is_empty() { valid.clone() } else { kept }
    } else {
        valid
    };

    filtered
        .into_iter()
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(site, price, url)| BestMatch { site, price, url })
}

pub async fn run_quote_collect(request: &QuoteRequest) -> Result<Vec<ItemResult>> {
    let ttl = ttl_seconds(request);
    let semaphore = Arc::new(Semaphore::new(20));
    let overrides = request.site_overrides.clone();

    let mut item_results = Vec::with_capacity(request.items.len());

    for item in &request.items {
        let tasks = request.site_plan.iter().cloned().map(|site| {
            let sem = semaphore.clone();
            let query = item.query.clone();
            let overrides = overrides.clone();
            async move {
                let permit = sem.acquire_owned().await;
                let Ok(_permit) = permit else {
                    let fallback = SiteMatch {
                        site: site.clone(),
                        title: None,
                        price: None,
                        currency: Some("USD".to_string()),
                        url: Some(site_url(&site, &query, overrides.as_ref())),
                        status: "error".to_string(),
                        message: Some("semaphore_closed".to_string()),
                        latency_ms: Some(0)
                    };
                    return (site, fallback);
                };
                let result = scrape_site(&site, &query, ttl, overrides.as_ref()).await;
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
