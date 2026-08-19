use crate::settings::PostProcessProvider;
use futures_util::stream::unfold;
use futures_util::Stream;
use futures_util::StreamExt;
use log::{debug, error, info};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::error::Error as StdError;
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Serialize)]
struct JsonSchema {
    name: String,
    strict: bool,
    schema: Value,
}

#[derive(Debug, Serialize)]
struct ResponseFormat {
    #[serde(rename = "type")]
    format_type: String,
    json_schema: JsonSchema,
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
struct ReasoningConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exclude: Option<bool>,
}

/// Request fields used to ask an endpoint to skip reasoning/thinking.
/// Providers disagree on the field name and accepted values, so at most one of
/// these is set per request (see `reasoning_disable_params`).
#[derive(Debug, Serialize, Clone, Default, PartialEq)]
struct ReasoningParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<ReasoningConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Value>,
}

impl ReasoningParams {
    fn is_empty(&self) -> bool {
        self.reasoning_effort.is_none() && self.reasoning.is_none() && self.thinking.is_none()
    }
}

/// Pick the reasoning-disable request fields an endpoint understands.
/// Unknown endpoints get the common OpenAI-style field; if they reject it,
/// the request is retried without it (see `send_chat_completion_with_schema`).
fn reasoning_disable_params(provider: &PostProcessProvider) -> ReasoningParams {
    let base_url = provider.base_url.to_lowercase();
    if base_url.contains("api.deepseek.com") {
        // DeepSeek rejects reasoning_effort "none" and uses its own field:
        // https://api-docs.deepseek.com/guides/thinking_mode
        ReasoningParams {
            thinking: Some(serde_json::json!({ "type": "disabled" })),
            ..Default::default()
        }
    } else if provider.id == "openrouter" {
        // OpenRouter nested object; exclude:true also keeps reasoning text out
        // of the response so it can't pollute structured-output JSON parsing
        ReasoningParams {
            reasoning: Some(ReasoningConfig {
                effort: Some("none".to_string()),
                exclude: Some(true),
            }),
            ..Default::default()
        }
    } else {
        ReasoningParams {
            reasoning_effort: Some("none".to_string()),
            ..Default::default()
        }
    }
}

/// Endpoints (base_url|model) that rejected the reasoning-disable fields with a
/// 4xx. Remembered for the lifetime of the process so every dictation after the
/// first skips the doomed attempt and goes straight to a plain request.
fn reasoning_rejections() -> &'static Mutex<HashSet<String>> {
    static REJECTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    REJECTED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn endpoint_key(provider: &PostProcessProvider, model: &str) -> String {
    format!("{}|{}", provider.base_url.trim_end_matches('/'), model)
}

fn is_known_rejected(key: &str) -> bool {
    reasoning_rejections()
        .lock()
        .map(|set| set.contains(key))
        .unwrap_or(false)
}

fn remember_rejection(key: String) {
    if let Ok(mut set) = reasoning_rejections().lock() {
        set.insert(key);
    }
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
    #[serde(flatten)]
    reasoning: ReasoningParams,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessageResponse,
}

#[derive(Debug, Deserialize)]
struct ChatMessageResponse {
    content: Option<String>,
}

/// Build headers for API requests based on provider type
fn build_headers(provider: &PostProcessProvider, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();

    // Common headers
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://github.com/hee10k/handy"),
    );
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("Tajagi/1.0 (+https://github.com/hee10k/handy)"),
    );
    headers.insert("X-Title", HeaderValue::from_static("Tajagi"));

    // Provider-specific auth headers
    if !api_key.is_empty() {
        if provider.id == "anthropic" {
            headers.insert(
                "x-api-key",
                HeaderValue::from_str(api_key)
                    .map_err(|e| format!("Invalid API key header value: {}", e))?,
            );
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        } else {
            headers.insert(
                AUTHORIZATION,
                HeaderValue::from_str(&format!("Bearer {}", api_key))
                    .map_err(|e| format!("Invalid authorization header value: {}", e))?,
            );
        }
    }

    Ok(headers)
}

/// Create an HTTP client with provider-specific headers
fn create_client(provider: &PostProcessProvider, api_key: &str) -> Result<reqwest::Client, String> {
    let headers = build_headers(provider, api_key)?;
    reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| report_reqwest_error("Failed to build HTTP client", &e))
}

/// Format a bounded error source chain.
///
/// `reqwest::Error`'s Display implementation intentionally gives only a short
/// summary. Nested causes contain the useful transport details, such as a
/// certificate validation failure, an HTTP/2 error, or a connection reset.
/// Callers must skip source types whose Display text can quote payload data.
fn error_source_chain(error: &(dyn StdError + 'static)) -> Vec<String> {
    let mut causes = Vec::new();
    let mut source = error.source();

    // Defensive cap in case a third-party error exposes a cyclic source chain.
    for _ in 0..16 {
        let Some(cause) = source else {
            break;
        };
        causes.push(cause.to_string());
        source = cause.source();
    }

    causes
}

fn reqwest_error_kinds(error: &reqwest::Error) -> String {
    let mut kinds = Vec::new();

    if error.is_builder() {
        kinds.push("builder");
    }
    if error.is_connect() {
        kinds.push("connect");
    }
    if error.is_request() {
        kinds.push("request");
    }
    if error.is_redirect() {
        kinds.push("redirect");
    }
    if error.is_timeout() {
        kinds.push("timeout");
    }
    if error.is_status() {
        kinds.push("status");
    }
    if error.is_body() {
        kinds.push("body");
    }
    if error.is_decode() {
        kinds.push("decode");
    }
    if error.is_upgrade() {
        kinds.push("upgrade");
    }

    if kinds.is_empty() {
        "unknown".to_string()
    } else {
        kinds.join(", ")
    }
}

fn sanitized_url(url: &reqwest::Url) -> String {
    let mut url = url.clone();

    // Custom endpoints should not contain credentials or query-string tokens,
    // but omit them from diagnostics in case one does.
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_query(None);
    url.set_fragment(None);

    url.to_string()
}

fn sanitized_url_for_log(url: &str) -> String {
    reqwest::Url::parse(url)
        .map(|url| sanitized_url(&url))
        // Do not echo an invalid URL: the parse failure might have been caused
        // by sensitive data entered in the custom endpoint field.
        .unwrap_or_else(|_| "<invalid URL>".to_string())
}

fn report_reqwest_error(context: &str, error: &reqwest::Error) -> String {
    let kinds = reqwest_error_kinds(error);
    let url = error
        .url()
        .map(sanitized_url)
        .map(|url| format!(", url: {url}"))
        .unwrap_or_default();

    // serde_json's error text can quote values from a malformed response. That
    // response may contain transcription content, so retain the useful decode
    // classification but never put its nested source in logs or UI errors.
    let causes = if error.is_decode() {
        Vec::new()
    } else {
        error_source_chain(error)
    };
    let cause_details = if !causes.is_empty() {
        format!(": caused by: {}", causes.join(" -> "))
    } else if error.url().is_none() {
        // Reqwest's short Display text is safe when it cannot append a raw URL.
        format!(": {error}")
    } else {
        // The sanitized URL is already included above. Avoid formatting the
        // original error because its Display implementation includes the raw URL.
        String::new()
    };

    let details = format!("{context} (kind: {kinds}{url}){cause_details}");
    error!("{details}");
    details
}

/// Send a chat completion request to an OpenAI-compatible API
/// Returns Ok(Some(content)) on success, Ok(None) if response has no content,
/// or Err on actual errors (HTTP, parsing, etc.)
pub async fn send_chat_completion(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    prompt: String,
    disable_reasoning: bool,
) -> Result<Option<String>, String> {
    send_chat_completion_with_schema(
        provider,
        api_key,
        model,
        prompt,
        None,
        None,
        disable_reasoning,
    )
    .await
}

/// Send a chat completion request with structured output support.
/// When json_schema is provided, uses structured outputs mode.
/// system_prompt is used as the system message when provided.
///
/// When disable_reasoning is set, the request carries the reasoning-disable
/// fields the endpoint is expected to understand. Not every OpenAI-compatible
/// endpoint accepts them (DeepSeek, Gemini's compat layer, and some OpenRouter
/// upstreams reject with 400), so a 400/422 answer to such a request triggers
/// one retry without the fields, and the rejection is remembered per
/// (base_url, model) so later requests skip the failing attempt entirely.
pub async fn send_chat_completion_with_schema(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    user_content: String,
    system_prompt: Option<String>,
    json_schema: Option<Value>,
    disable_reasoning: bool,
) -> Result<Option<String>, String> {
    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);

    debug!(
        "Sending chat completion request to: {}",
        sanitized_url_for_log(&url)
    );

    let client = create_client(provider, &api_key)?;

    // Build messages vector
    let mut messages = Vec::new();

    // Add system prompt if provided
    if let Some(system) = system_prompt {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: system,
        });
    }

    // Add user message
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_content,
    });

    // Build response_format if schema is provided
    let response_format = json_schema.map(|schema| ResponseFormat {
        format_type: "json_schema".to_string(),
        json_schema: JsonSchema {
            name: "transcription_output".to_string(),
            strict: true,
            schema,
        },
    });

    let key = endpoint_key(provider, model);
    let reasoning = if disable_reasoning && !is_known_rejected(&key) {
        reasoning_disable_params(provider)
    } else {
        ReasoningParams::default()
    };

    let mut request_body = ChatCompletionRequest {
        model: model.to_string(),
        messages,
        stream: false,
        response_format,
        reasoning,
    };

    let mut response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| report_reqwest_error("HTTP request failed", &e))?;
    let mut status = response.status();
    debug!(
        "Chat completion response received with status {} over {:?} from {}",
        status,
        response.version(),
        sanitized_url(response.url())
    );

    // A 400/422 on a request carrying reasoning-disable fields is almost always
    // the endpoint rejecting those fields — retry once without them.
    if !status.is_success()
        && matches!(status.as_u16(), 400 | 422)
        && !request_body.reasoning.is_empty()
    {
        let error_text = response.text().await.unwrap_or_else(|e| {
            report_reqwest_error("Failed to read reasoning rejection response", &e)
        });
        info!(
            "Endpoint rejected request with reasoning disabled (status {}): {}. Retrying without reasoning fields",
            status, error_text
        );

        request_body.reasoning = ReasoningParams::default();
        response = client
            .post(&url)
            .json(&request_body)
            .send()
            .await
            .map_err(|e| report_reqwest_error("HTTP retry failed", &e))?;
        status = response.status();
        debug!(
            "Chat completion retry response received with status {} over {:?} from {}",
            status,
            response.version(),
            sanitized_url(response.url())
        );

        if status.is_success() {
            info!(
                "Retry without reasoning fields succeeded; '{}' (model '{}') will skip them from now on",
                sanitized_url_for_log(base_url), model
            );
            remember_rejection(key);
        }
    }

    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|e| report_reqwest_error("Failed to read API error response", &e));
        return Err(format!(
            "API request failed with status {}: {}",
            status, error_text
        ));
    }

    let completion: ChatCompletionResponse = response
        .json()
        .await
        .map_err(|e| report_reqwest_error("Failed to parse API response", &e))?;

    Ok(completion
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone()))
}

/// Fetch available models from an OpenAI-compatible API
/// Returns a list of model IDs
pub async fn fetch_models(
    provider: &PostProcessProvider,
    api_key: String,
) -> Result<Vec<String>, String> {
    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/models", base_url);

    debug!("Fetching models from: {}", sanitized_url_for_log(&url));

    let client = create_client(provider, &api_key)?;

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| report_reqwest_error("Failed to fetch models", &e))?;

    let status = response.status();
    debug!(
        "Model list response received with status {} over {:?} from {}",
        status,
        response.version(),
        sanitized_url(response.url())
    );
    if !status.is_success() {
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|e| report_reqwest_error("Failed to read model list error", &e));
        return Err(format!(
            "Model list request failed ({}): {}",
            status, error_text
        ));
    }

    let parsed: serde_json::Value = response
        .json()
        .await
        .map_err(|e| report_reqwest_error("Failed to parse model list response", &e))?;

    let mut models = Vec::new();

    // Handle OpenAI format: { data: [ { id: "..." }, ... ] }
    if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
        for entry in data {
            if let Some(id) = entry.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            } else if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                models.push(name.to_string());
            }
        }
    }
    // Handle array format: [ "model1", "model2", ... ]
    else if let Some(array) = parsed.as_array() {
        for entry in array {
            if let Some(model) = entry.as_str() {
                models.push(model.to_string());
            }
        }
    }

    Ok(models)
}

/// Errors surfaced while streaming a chat completion. The `status` is kept out
/// of any serialized body so upstream callers can classify 401/429/5xx into
/// user-facing messages without ever echoing an endpoint's raw error body
/// (which can quote user content or API keys).
#[derive(Debug)]
pub enum ChatStreamError {
    /// Non-2xx response. The body is intentionally NOT exposed to callers —
    /// only the status code, which is enough to classify auth/rate-limit/server
    /// failures without risking secret leakage.
    HttpStatus { status: u16 },
    /// Transport/network failure (DNS, connect, TLS, timeout, read error).
    Transport(String),
    /// Failed to parse the streaming response into content deltas.
    Decode(String),
}

impl std::fmt::Display for ChatStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ChatStreamError::HttpStatus { status } => {
                write!(f, "HTTP error with status {}", status)
            }
            ChatStreamError::Transport(msg) => write!(f, "{}", msg),
            ChatStreamError::Decode(msg) => write!(f, "{}", msg),
        }
    }
}

/// Extract completed SSE `data:` deltas from a byte chunk, buffering any
/// trailing partial line in `pending` for the next chunk. Returns the collected
/// content deltas (empty strings are dropped) and whether the stream signalled
/// completion with the `data: [DONE]` sentinel.
///
/// Non-`data:` lines (comments, blank keepalives) and lines whose JSON does not
/// parse (or carry no `choices[0].delta.content`) are ignored, so a malformed
/// keepalive never corrupts the transcript.
fn sse_extract_deltas(pending: &mut Vec<u8>, chunk: &[u8]) -> (Vec<String>, bool) {
    pending.extend_from_slice(chunk);
    let mut deltas = Vec::new();
    let mut done = false;

    loop {
        let Some(newline) = pending.iter().position(|&b| b == b'\n') else {
            break; // no complete line yet; keep the remainder buffered
        };
        // Copy the complete line out first so we can mutate `pending` (drain)
        // without holding a borrow into it.
        let mut line = pending[..newline].to_vec();
        pending.drain(..=newline);
        if line.last() == Some(&b'\r') {
            line.pop();
        }

        let text = String::from_utf8_lossy(&line);
        let trimmed = text.trim();
        let Some(data) = trimmed.strip_prefix("data:") else {
            continue;
        };
        let payload = data.trim_start();
        if payload == "[DONE]" {
            done = true;
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(payload) {
            if let Some(content) = value
                .pointer("/choices/0/delta/content")
                .and_then(|c| c.as_str())
            {
                if !content.is_empty() {
                    deltas.push(content.to_string());
                }
            }
        }
    }

    (deltas, done)
}

/// Send a chat completion request that streams its response as Server-Sent
/// Events, reusing the existing OpenAI-compatible client, provider header
/// building, and error sanitization.
///
/// On success this returns a stream that yields batches of content deltas
/// (`Vec<String>`); the stream terminates naturally at `data: [DONE]` or at the
/// end of the HTTP body. Pre-stream failures (transport, non-2xx status) are
/// returned as `Err`, and mid-stream failures surface as `Err` items.
pub async fn send_chat_completion_stream(
    provider: &PostProcessProvider,
    api_key: String,
    model: &str,
    system_prompt: Option<String>,
    user_content: String,
    disable_reasoning: bool,
) -> Result<impl Stream<Item = Result<Vec<String>, ChatStreamError>>, ChatStreamError> {
    let base_url = provider.base_url.trim_end_matches('/');
    let url = format!("{}/chat/completions", base_url);
    debug!(
        "Sending streaming chat completion request to: {}",
        sanitized_url_for_log(&url)
    );

    let client = create_client(provider, &api_key).map_err(ChatStreamError::Transport)?;

    let mut messages = Vec::new();
    if let Some(system) = system_prompt {
        messages.push(ChatMessage {
            role: "system".to_string(),
            content: system,
        });
    }
    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_content,
    });

    let key = endpoint_key(provider, model);
    let reasoning = if disable_reasoning && !is_known_rejected(&key) {
        reasoning_disable_params(provider)
    } else {
        ReasoningParams::default()
    };

    let mut request_body = ChatCompletionRequest {
        model: model.to_string(),
        messages,
        stream: true,
        response_format: None,
        reasoning,
    };

    let mut response = client
        .post(&url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| ChatStreamError::Transport(report_reqwest_error("HTTP request failed", &e)))?;
    let mut status = response.status();
    debug!(
        "Streaming chat completion response received with status {} over {:?} from {}",
        status,
        response.version(),
        sanitized_url(response.url())
    );

    // A 400/422 on a request carrying reasoning-disable fields is almost always
    // the endpoint rejecting those fields — retry once without them. Mirror the
    // non-streaming path so streaming consumers (e.g. transform) self-heal too.
    if !status.is_success()
        && matches!(status.as_u16(), 400 | 422)
        && !request_body.reasoning.is_empty()
    {
        // Read and discard the body so the connection is released (it can quote
        // secrets/content, so it is never propagated).
        let error_text = response
            .text()
            .await
            .unwrap_or_else(|e| report_reqwest_error("Failed to read reasoning rejection response", &e));
        info!(
            "Streaming endpoint rejected request with reasoning disabled (status {}): {}. Retrying without reasoning fields",
            status, error_text
        );

        request_body.reasoning = ReasoningParams::default();
        response = client
            .post(&url)
            .json(&request_body)
            .send()
            .await
            .map_err(|e| ChatStreamError::Transport(report_reqwest_error("HTTP retry failed", &e)))?;
        status = response.status();
        debug!(
            "Streaming chat completion retry response received with status {} over {:?} from {}",
            status,
            response.version(),
            sanitized_url(response.url())
        );

        if status.is_success() {
            info!(
                "Retry without reasoning fields succeeded; '{}' (model '{}') will skip them from now on",
                sanitized_url_for_log(base_url), model
            );
            remember_rejection(key);
        }
    }

    if !status.is_success() {
        // Read and discard the body so the connection is released. The raw body
        // is never propagated (it can quote secrets/content).
        let _ = response
            .text()
            .await
            .map_err(|e| report_reqwest_error("Failed to read error response", &e));
        return Err(ChatStreamError::HttpStatus {
            status: status.as_u16(),
        });
    }

    let byte_stream = response.bytes_stream();
    // (byte_stream, pending-line buffer, done flag)
    let seed = (byte_stream, Vec::<u8>::new(), false);

    Ok(unfold(seed, |(mut stream, mut buffer, mut done)| async move {
        if done {
            return None;
        }
        loop {
            match stream.next().await {
                Some(Ok(chunk)) => {
                    let (deltas, stream_done) = sse_extract_deltas(&mut buffer, &chunk);
                    if stream_done {
                        done = true;
                    }
                    if !deltas.is_empty() {
                        return Some((Ok(deltas), (stream, buffer, done)));
                    }
                    if done {
                        return None;
                    }
                    // No complete deltas yet and not done: keep reading.
                }
                Some(Err(e)) => {
                    let err = ChatStreamError::Transport(report_reqwest_error(
                        "Streaming response read failed",
                        &e,
                    ));
                    return Some((Err(err), (stream, buffer, done)));
                }
                None => {
                    // Producer ended without an explicit [DONE]; flush a residual
                    // tail if a partial line remained.
                    let residual = String::from_utf8_lossy(&buffer).trim().to_string();
                    if residual.is_empty() {
                        return None;
                    }
                    return Some((Ok(vec![residual]), (stream, Vec::new(), true)));
                }
            }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Debug)]
    struct TestError {
        message: &'static str,
        source: Option<Box<TestError>>,
    }

    impl fmt::Display for TestError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.message)
        }
    }

    impl StdError for TestError {
        fn source(&self) -> Option<&(dyn StdError + 'static)> {
            self.source
                .as_deref()
                .map(|source| source as &(dyn StdError + 'static))
        }
    }

    fn provider(id: &str, base_url: &str) -> PostProcessProvider {
        PostProcessProvider {
            id: id.to_string(),
            label: id.to_string(),
            base_url: base_url.to_string(),
            allow_base_url_edit: true,
            models_endpoint: None,
            supports_structured_output: false,
        }
    }

    fn request_json(reasoning: ReasoningParams) -> Value {
        let request = ChatCompletionRequest {
            model: "test-model".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "hi".to_string(),
            }],
            stream: false,
            response_format: None,
            reasoning,
        };
        serde_json::to_value(&request).unwrap()
    }

    async fn serve_one_response(status: &str, body: &str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).await.unwrap();
            stream.write_all(response.as_bytes()).await.unwrap();
        });

        format!("http://{address}")
    }

    #[test]
    fn error_source_chain_includes_all_nested_causes() {
        let error = TestError {
            message: "request failed",
            source: Some(Box::new(TestError {
                message: "TLS handshake failed",
                source: Some(Box::new(TestError {
                    message: "unknown certificate authority",
                    source: None,
                })),
            })),
        };

        assert_eq!(
            error_source_chain(&error),
            vec!["TLS handshake failed", "unknown certificate authority"]
        );
    }

    #[test]
    fn log_url_sanitization_removes_credentials_and_tokens() {
        let url = "https://user:password@example.com/v1/models?api_key=secret#private";
        assert_eq!(sanitized_url_for_log(url), "https://example.com/v1/models");
    }

    #[test]
    fn invalid_log_urls_are_not_echoed() {
        assert_eq!(
            sanitized_url_for_log("not a URL containing secret"),
            "<invalid URL>"
        );
    }

    #[tokio::test]
    async fn decode_error_does_not_echo_response_values() {
        let base_url =
            serve_one_response("200 OK", r#"{"choices":"PRIVATE TRANSCRIPTION CONTENT"}"#).await;
        let error = reqwest::get(base_url)
            .await
            .unwrap()
            .json::<ChatCompletionResponse>()
            .await
            .unwrap_err();

        let details = report_reqwest_error("Failed to parse API response", &error);
        assert!(details.contains("kind: decode"));
        assert!(!details.contains("PRIVATE TRANSCRIPTION CONTENT"));
    }

    #[tokio::test]
    async fn raw_error_url_is_not_reintroduced_without_a_source() {
        let base_url = serve_one_response("400 Bad Request", "bad request").await;
        let error = reqwest::get(format!(
            "{base_url}/private?api_key=SECRET_QUERY_TOKEN#private"
        ))
        .await
        .unwrap()
        .error_for_status()
        .unwrap_err();

        let details = report_reqwest_error("Request failed", &error);
        assert!(details.contains(&format!("url: {base_url}/private")));
        assert!(!details.contains("SECRET_QUERY_TOKEN"));
        assert!(!details.contains("#private"));
    }

    #[test]
    fn requests_explicitly_disable_streaming() {
        let json = request_json(ReasoningParams::default());
        assert_eq!(json["stream"], false);
    }

    #[test]
    fn default_reasoning_params_serialize_to_no_fields() {
        let json = request_json(ReasoningParams::default());
        assert!(json.get("reasoning_effort").is_none());
        assert!(json.get("reasoning").is_none());
        assert!(json.get("thinking").is_none());
    }

    #[test]
    fn custom_provider_uses_top_level_reasoning_effort() {
        let params = reasoning_disable_params(&provider("custom", "http://localhost:11434/v1"));
        let json = request_json(params);
        assert_eq!(json["reasoning_effort"], "none");
        assert!(json.get("reasoning").is_none());
        assert!(json.get("thinking").is_none());
    }

    #[test]
    fn openrouter_uses_nested_reasoning_object() {
        let params =
            reasoning_disable_params(&provider("openrouter", "https://openrouter.ai/api/v1"));
        let json = request_json(params);
        assert!(json.get("reasoning_effort").is_none());
        assert_eq!(json["reasoning"]["effort"], "none");
        assert_eq!(json["reasoning"]["exclude"], true);
        assert!(json.get("thinking").is_none());
    }

    #[test]
    fn deepseek_base_url_uses_thinking_disabled() {
        let params = reasoning_disable_params(&provider("custom", "https://api.deepseek.com"));
        let json = request_json(params);
        assert!(json.get("reasoning_effort").is_none());
        assert!(json.get("reasoning").is_none());
        assert_eq!(json["thinking"]["type"], "disabled");
    }

    #[test]
    fn reasoning_params_is_empty_tracks_all_fields() {
        assert!(ReasoningParams::default().is_empty());
        assert!(!ReasoningParams {
            reasoning_effort: Some("none".to_string()),
            ..Default::default()
        }
        .is_empty());
        assert!(!ReasoningParams {
            thinking: Some(serde_json::json!({ "type": "disabled" })),
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn rejection_memo_is_keyed_by_base_url_and_model() {
        let deepseek = provider("custom", "https://api.deepseek.com/");
        let key = endpoint_key(&deepseek, "deepseek-chat");
        assert_eq!(key, "https://api.deepseek.com|deepseek-chat");
        assert!(!is_known_rejected(&key));
        remember_rejection(key.clone());
        assert!(is_known_rejected(&key));
        // A different model on the same endpoint is tracked separately
        assert!(!is_known_rejected(&endpoint_key(&deepseek, "other-model")));
    }

    // ---------------------------------------------------------------- streaming

    fn sse_chunk(pending: &mut Vec<u8>, chunk: &str) -> (Vec<String>, bool) {
        sse_extract_deltas(pending, chunk.as_bytes())
    }

    #[test]
    fn sse_extracts_deltas_across_chunk_boundaries() {
        let mut pending = Vec::new();
        let full = "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"lo \"}}]}\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n";

        // Feed partial chunks so a single message spans multiple frames.
        let (d1, done1) = sse_chunk(&mut pending, &full[..20]);
        assert_eq!(d1, Vec::<String>::new());
        assert!(!done1);

        let (d2, _done2) = sse_chunk(&mut pending, &full[20..]);
        assert_eq!(d2, vec!["Hel".to_string(), "lo ".to_string(), "world".to_string()]);
        // The trailing blank line yields no further delta and nothing is left.
        assert!(pending.is_empty());
    }

    #[test]
    fn sse_done_sentinel_terminates_and_content_null_is_ignored() {
        let mut pending = Vec::new();
        let (deltas, done) = sse_chunk(
            &mut pending,
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\
             data: {\"choices\":[{\"delta\":{\"content\":null},\"finish_reason\":\"stop\"}]}\n\
             data: [DONE]\n\n",
        );
        assert_eq!(deltas, vec!["ok".to_string()]);
        assert!(done);
    }

    #[test]
    fn sse_ignores_non_data_and_malformed_lines() {
        let mut pending = Vec::new();
        let (deltas, done) = sse_chunk(
            &mut pending,
            ": keepalive\n\n\
             data: [DONE]\n",
        );
        assert!(deltas.is_empty());
        assert!(done);
    }

    #[test]
    fn sse_handles_crlf_line_endings() {
        let mut pending = Vec::new();
        let (deltas, done) = sse_chunk(
            &mut pending,
            "data: {\"choices\":[{\"delta\":{\"content\":\"yes\"}}]}\r\ndata: [DONE]\r\n",
        );
        assert_eq!(deltas, vec!["yes".to_string()]);
        assert!(done);
    }

    #[tokio::test]
    async fn stream_end_to_end_transcribes_sse_body() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"one\"}}]}\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"two\"}}]}\n\
                    data: [DONE]\n\n";
        let base_url = serve_one_response("200 OK", body).await;
        let p = provider("openai", &base_url);

        let mut stream = send_chat_completion_stream(
            &p,
            String::new(),
            "test-model",
            Some("be brief".to_string()),
            "hello".to_string(),
            false,
        )
        .await
        .expect("request should start")
        .boxed();

        let mut collected = String::new();
        while let Some(item) = stream.next().await {
            for delta in item.expect("delta batch") {
                collected.push_str(&delta);
            }
        }
        assert_eq!(collected, "onetwo");
    }

    #[tokio::test]
    async fn stream_surfaces_http_status_without_body() {
        // 401 body mentions a secret to prove it is never propagated.
        let base_url =
            serve_one_response("401 Unauthorized", r#"{"error":"bad key sk-secret-ABC"}"#).await;
        let p = provider("openai", &base_url);

        let err = match send_chat_completion_stream(
            &p,
            String::from("sk-secret-ABC"),
            "test-model",
            None,
            "hi".to_string(),
            false,
        )
        .await
        {
            Err(err) => err,
            Ok(_) => panic!("non-2xx must fail before a stream is returned"),
        };

        match err {
            ChatStreamError::HttpStatus { status } => assert_eq!(status, 401),
            other => panic!("expected HttpStatus, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn stream_request_serializes_stream_true() {
        let base_url = serve_one_response("200 OK", "data: [DONE]\n\n").await;
        let p = provider("openai", &base_url);

        // Build the same request body the stream path constructs, then assert
        // the wire contract (stream:true, system message first).
        let mut messages = vec![ChatMessage {
            role: "system".to_string(),
            content: "be brief".to_string(),
        }];
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: "hi".to_string(),
        });
        let request = ChatCompletionRequest {
            model: "test-model".to_string(),
            messages,
            stream: true,
            response_format: None,
            reasoning: ReasoningParams::default(),
        };
        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["stream"], true);
        assert_eq!(json["messages"][0]["role"], "system");
        assert_eq!(json["messages"][1]["role"], "user");
    }

    /// Serve exactly two requests: a 400 (reasoning-field rejection) then a
    /// 200 SSE body. Returns the base URL and the streamed delta.
    async fn serve_reject_then_sse(
        first_delta: &str,
    ) -> (String, String) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let reject = format!(
            "HTTP/1.1 400 Bad Request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            "reasoning_effort unsupported".len(),
            "reasoning_effort unsupported"
        );
        let sse_body = format!(
            "data: {{\"choices\":[{{\"delta\":{{\"content\":\"{}\"}}}}]}}\n\ndata: [DONE]\n\n",
            first_delta
        );
        let ok =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse_body}", sse_body.len());

        tokio::spawn(async move {
            // First connection: reject with 400.
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut req = [0_u8; 4096];
            let _ = stream.read(&mut req).await.unwrap();
            stream.write_all(reject.as_bytes()).await.unwrap();
            drop(stream);
            // Second connection: the retry without reasoning fields -> 200 SSE.
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut req = [0_u8; 4096];
            let _ = stream.read(&mut req).await.unwrap();
            stream.write_all(ok.as_bytes()).await.unwrap();
        });

        (format!("http://{address}"), first_delta.to_string())
    }

    #[tokio::test]
    async fn stream_retries_without_reasoning_fields_on_4xx() {
        // custom provider + disable_reasoning=true is exactly the transform
        // path: it sends reasoning_effort:"none", which some endpoints (e.g.
        // Alibaba token-plan) reject with 400. The stream must self-heal by
        // retrying without the reasoning fields and remember the endpoint.
        let (base_url, expected) = serve_reject_then_sse("das boiled").await;
        let p = provider("custom", &base_url);

        let mut stream = send_chat_completion_stream(
            &p,
            String::from("k"),
            "test-model",
            None,
            "boiled".to_string(),
            true, // disable_reasoning
        )
        .await
        .expect("should retry and succeed");

        futures_util::pin_mut!(stream);
        let mut joined = String::new();
        while let Some(item) = stream.next().await {
            match item {
                Ok(deltas) => joined.push_str(&deltas.concat()),
                Err(e) => panic!("stream failed after retry: {e:?}"),
            }
        }
        assert_eq!(joined, expected, "delta must survive the reasoning retry");
        // The rejected (base_url, model) pair is remembered so later calls skip it.
        assert!(is_known_rejected(&endpoint_key(&p, "test-model")));
    }
}
