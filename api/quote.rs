mod shared;

use std::time::Instant;

use chrono::Utc;
use http_body_util::BodyExt;
use hyper::{Response, StatusCode};
use serde_json::json;
use uuid::Uuid;
use vercel_runtime::{Error, Request, ResponseBody};

use shared::{QuoteRequest, QuoteResponse, run_quote_collect};

fn json_response(status: StatusCode, body: serde_json::Value) -> Result<Response<ResponseBody>, Error> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(ResponseBody::from(body))
        .map_err(Into::into)
}

async fn handler(request: Request) -> Result<Response<ResponseBody>, Error> {
    if request.method() != "POST" {
        return json_response(StatusCode::METHOD_NOT_ALLOWED, json!({ "error": "method_not_allowed" }));
    }

    let body = request.into_body().collect().await?.to_bytes();
    let payload: QuoteRequest = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({ "error": "invalid_json", "message": error.to_string() }),
            )
        }
    };

    let run_id = payload
        .run_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let started_at = Utc::now().to_rfc3339();
    let started = Instant::now();

    let items = match run_quote_collect(&payload).await {
        Ok(items) => items,
        Err(error) => {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "quote_failed", "message": error.to_string() }),
            )
        }
    };

    let response = QuoteResponse {
        run_id,
        started_at,
        duration_ms: started.elapsed().as_millis(),
        items,
    };

    json_response(StatusCode::OK, serde_json::to_value(response)?)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    vercel_runtime::run(vercel_runtime::service_fn::<_, (Request,)>(handler)).await
}
