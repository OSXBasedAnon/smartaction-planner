#[path = "../src/shared.rs"]
mod shared;

use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use futures::stream::{self, StreamExt};
use http_body_util::{BodyExt, StreamBody};
use hyper::body::{Bytes, Frame};
use hyper::{Response, StatusCode};
use serde_json::json;
use tokio::sync::Semaphore;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use uuid::Uuid;
use vercel_runtime::{Error, Request, ResponseBody};

use shared::{QuoteRequest, best_from_matches, scrape_site};

fn sse_line(payload: serde_json::Value) -> String {
    format!("data: {}\n\n", payload)
}

fn response_sse(status: StatusCode, body: String) -> Result<Response<ResponseBody>, Error> {
    Response::builder()
        .status(status)
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache")
        .body(ResponseBody::from(body))
        .map_err(Into::into)
}

async fn handler(request: Request) -> Result<Response<ResponseBody>, Error> {
    if request.method() != "POST" {
        return response_sse(
            StatusCode::METHOD_NOT_ALLOWED,
            sse_line(json!({"type":"error","message":"method_not_allowed"})),
        );
    }

    let body = request.into_body().collect().await?.to_bytes();
    let payload: QuoteRequest = match serde_json::from_slice(&body) {
        Ok(data) => data,
        Err(error) => {
            return response_sse(
                StatusCode::BAD_REQUEST,
                sse_line(json!({"type":"error","message":format!("invalid_json: {error}")})),
            );
        }
    };

    let run_id = payload
        .run_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let started_at = Utc::now().to_rfc3339();
    let started = Instant::now();
    let ttl = payload
        .options
        .as_ref()
        .and_then(|options| options.cache_ttl)
        .unwrap_or_else(|| {
            std::env::var("CACHE_TTL_SECONDS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
        });

    let semaphore = Arc::new(Semaphore::new(20));
    let overrides = payload.site_overrides.clone();
    let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, Error>>(64);

    tokio::spawn(async move {
        let _ = tx
            .send(Ok(Frame::data(Bytes::from(sse_line(json!({
                "type": "started",
                "run_id": run_id,
                "started_at": started_at
            }))))))
            .await;

        for (item_index, item) in payload.items.iter().enumerate() {
            let query = item.query.clone();
            let tasks = payload.site_plan.iter().cloned().map(|site| {
                let sem = semaphore.clone();
                let query_clone = query.clone();
                let overrides = overrides.clone();
                let site_clone = site.clone();
                async move {
                    let permit = sem.acquire_owned().await;
                    let Ok(_permit) = permit else {
                        return shared::SiteMatch {
                            site: site_clone.clone(),
                            title: None,
                            price: None,
                            currency: Some("USD".to_string()),
                            url: None,
                            status: "error".to_string(),
                            message: Some("semaphore_closed".to_string()),
                            latency_ms: Some(0)
                        };
                    };
                    scrape_site(&site, &query_clone, ttl, overrides.as_ref()).await
                }
            });

            let mut matches = Vec::new();
            let mut scrape_stream = stream::iter(tasks).buffer_unordered(20);

            while let Some(result) = scrape_stream.next().await {
                let _ = tx
                    .send(Ok(Frame::data(Bytes::from(sse_line(json!({
                        "type": "match",
                        "item_index": item_index,
                        "query": query,
                        "match": result
                    }))))))
                    .await;
                matches.push(result);
            }

            let best = best_from_matches(&matches);
            let _ = tx
                .send(Ok(Frame::data(Bytes::from(sse_line(json!({
                    "type": "item_done",
                    "item_index": item_index,
                    "query": query,
                    "best": best
                }))))))
                .await;
        }

        let _ = tx
            .send(Ok(Frame::data(Bytes::from(sse_line(json!({
                "type": "done",
                "duration_ms": started.elapsed().as_millis()
            }))))))
            .await;
    });

    let stream_body = StreamBody::new(ReceiverStream::new(rx));
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache")
        .body(ResponseBody::from(stream_body))
        .map_err(Into::into)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    vercel_runtime::run(vercel_runtime::service_fn::<_, (Request,)>(handler)).await
}
