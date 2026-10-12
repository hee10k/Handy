//! Constrained local text inference resolver for bilingual interpretation.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "lowercase")]
pub enum AutoLanguage {
    Ko,
    En,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct AutoInputSpan {
    pub id: u32,
    pub ko: String,
    pub en: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct AutoInputDecision {
    pub id: u32,
    pub language: AutoLanguage,
}

/// Request body for llama-server /completion endpoint.
#[derive(Serialize)]
struct LlamaCompletionRequest<'a> {
    prompt: &'a str,
    temperature: f32,
    n_predict: u32,
    grammar: &'a str,
    logprobs: bool,
    n_probs: usize,
    cache_prompt: bool,
    stream: bool,
}

/// Response body from llama-server /completion endpoint.
#[derive(Deserialize)]
struct LlamaCompletionResponse {
    #[serde(default)]
    completion_probabilities: Vec<CompletionProbabilities>,
}

#[derive(Deserialize)]
struct CompletionProbabilities {
    /// llama.cpp b11429 field name for the first-token distribution.
    #[serde(default)]
    top_logprobs: Vec<TopLogprob>,
    #[serde(default)]
    probs: Vec<TopLogprob>,
}

#[derive(Deserialize)]
struct TopLogprob {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    tok_str: Option<String>,
    logprob: f64,
}

#[derive(Serialize)]
struct TokenizeRequest<'a> {
    content: &'a str,
    add_special: bool,
}

#[derive(Deserialize)]
struct TokenizeResponse {
    tokens: Vec<serde_json::Value>,
}

pub const RUNTIME_CONTEXT_LIMIT: usize = 2048;
const SAFETY_MARGIN: usize = 32;
const OUTPUT_TOKENS: usize = 1;

/// Sampling settings validated on 2026-10-12 (production path: pinned llama.cpp
/// b11429 `/completion`, Qwen3-0.6B-Q8_0): greedy decoding of a single
/// grammar-constrained verdict token per candidate.
pub fn completion_parameters() -> (f32, u32) {
    (0.0, OUTPUT_TOKENS as u32)
}

/// Alternative first-token logprobs requested per verdict. The window must be
/// wide enough for both `yes` and `no` to appear, so the margin is a real
/// comparison rather than a fallback.
const PROB_WINDOW: usize = 20;

/// Logprob credited to a verdict token missing from the window. Identical to the
/// benchmark harness, so the measured decision behaviour is what ships.
const ABSENT_VERDICT_LOGPROB: f64 = -30.0;

const VERDICT_GRAMMAR: &str = r#"root ::= "yes" | "no""#;

/// Uses the loaded model's actual tokenizer. Failure is actionable rather than
/// guessing a budget that could truncate immutable candidates at inference.
async fn count_tokens(
    client: &reqwest::Client,
    port: u16,
    token: &str,
    text: &str,
) -> Result<usize> {
    let response = client
        .post(format!("http://127.0.0.1:{}/tokenize", port))
        .bearer_auth(token)
        .json(&TokenizeRequest {
            content: text,
            add_special: true,
        })
        .send()
        .await
        .map_err(|e| anyhow!("Cannot measure input with the local model tokenizer: {}", e))?
        .error_for_status()
        .map_err(|e| anyhow!("Local model tokenizer rejected input: {}", e))?;
    let parsed = response
        .json::<TokenizeResponse>()
        .await
        .map_err(|e| anyhow!("Invalid local model tokenizer response: {}", e))?;
    Ok(parsed.tokens.len())
}

/// Both verdict prompts for one span, sharing the rolling history prefix.
fn verdict_prompts(context: &str, span: &AutoInputSpan) -> (String, String) {
    (
        build_verdict_prompt(context, &span.ko, AutoLanguage::Ko),
        build_verdict_prompt(context, &span.en, AutoLanguage::En),
    )
}

/// Whether both verdict prompts for this suffix fit the per-request budget.
async fn verdict_prompts_fit(
    client: &reqwest::Client,
    port: u16,
    token: &str,
    context: &str,
    span: &AutoInputSpan,
    budget: usize,
) -> Result<bool> {
    let (ko_prompt, en_prompt) = verdict_prompts(context, span);
    Ok(
        count_tokens(client, port, token, &ko_prompt).await? <= budget
            && count_tokens(client, port, token, &en_prompt).await? <= budget,
    )
}

/// Measure the entire assembled template, not additive token estimates: BPE
/// boundaries can change when history and candidates are concatenated.
/// Only preceding history is trimmed; candidates are never clipped.
async fn fit_verdict_prompt(
    client: &reqwest::Client,
    port: u16,
    token: &str,
    context: &str,
    span: &AutoInputSpan,
) -> Result<(String, String, usize)> {
    let budget = RUNTIME_CONTEXT_LIMIT - OUTPUT_TOKENS - SAFETY_MARGIN;
    for language in [AutoLanguage::Ko, AutoLanguage::En] {
        let prompt = build_verdict_prompt("", candidate_text(span, language), language);
        let candidate_tokens = count_tokens(client, port, token, &prompt).await?;
        if candidate_tokens > budget {
            return Err(anyhow!(
                "Span {} needs {} input tokens, exceeding the {} token budget. Split this word or choose its language manually; original keys are preserved.",
                span.id, candidate_tokens, budget,
            ));
        }
    }
    let (full_ko, full_en) = verdict_prompts(context, span);
    if count_tokens(client, port, token, &full_ko).await? <= budget
        && count_tokens(client, port, token, &full_en).await? <= budget
    {
        return Ok((full_ko, full_en, 0));
    }

    let boundaries: Vec<usize> = context
        .char_indices()
        .map(|(i, _)| i)
        .chain(std::iter::once(context.len()))
        .collect();
    let mut low = 0;
    let mut high = boundaries.len() - 1;
    let mut fitted = (verdict_prompts("", span), context.len());
    while low < high {
        let mid = low + (high - low) / 2;
        let start = boundaries[mid];
        if verdict_prompts_fit(client, port, token, &context[start..], span, budget).await? {
            fitted = (verdict_prompts(&context[start..], span), start);
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    // The stored prompts have themselves passed the tokenizer budget, even when
    // token merges make suffix token counts non-monotonic.
    let (ko_prompt, en_prompt) = fitted.0;
    Ok((ko_prompt, en_prompt, fitted.1))
}

/// Immutable candidate text for one language (never truncated or rewritten).
fn candidate_text(span: &AutoInputSpan, language: AutoLanguage) -> &str {
    match language {
        AutoLanguage::Ko => &span.ko,
        AutoLanguage::En => &span.en,
    }
}

/// Template `qwen3-0.6b-independent-verdict-v1`, validated 2026-10-12 on the
/// production path (pinned llama.cpp b11429 `/completion`, Qwen3-0.6B-Q8_0):
/// 79.7% raw accuracy with 0/78 option-order flips, versus 50.0% and 78/78 flips
/// for one prompt that asks the model to pick between candidate "1" and "2".
/// Judging each candidate on its own removes both option-order anchoring and the
/// literal-match bias towards the candidate that repeats the raw keystrokes.
fn build_verdict_prompt(context: &str, candidate: &str, language: AutoLanguage) -> String {
    let name = match language {
        AutoLanguage::Ko => "Korean",
        AutoLanguage::En => "English",
    };
    format!(
        "Is \"{candidate}\" a natural, correctly spelled {name} word that a person would intend to type here?\nContext: \"{context}\"\nAnswer yes or no, nothing else.\nAnswer:"
    )
}

/// Verdict for one candidate: log P(yes) - log P(no) at the first generated
/// token of the constrained answer. Positive means the model accepts it.
fn verdict_margin(response: &LlamaCompletionResponse) -> Result<f64> {
    let mut window: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    if let Some(entry) = response.completion_probabilities.first() {
        for prob in entry.top_logprobs.iter().chain(entry.probs.iter()) {
            let token = prob
                .tok_str
                .as_deref()
                .or(prob.token.as_deref())
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase();
            if token.is_empty() {
                continue;
            }
            let slot = window.entry(token).or_insert(prob.logprob);
            if prob.logprob > *slot {
                *slot = prob.logprob;
            }
        }
    }
    let yes = window.get("yes").copied().ok_or_else(|| {
        anyhow!("Local model returned no yes/no probability window for this candidate")
    })?;
    Ok(yes - window.get("no").copied().unwrap_or(ABSENT_VERDICT_LOGPROB))
}

/// Asks the local model to accept or reject one candidate on its own, and
/// returns the log-probability margin between the `yes` and `no` verdicts.
async fn verdict(client: &reqwest::Client, url: &str, token: &str, prompt: &str) -> Result<f64> {
    let (temperature, n_predict) = completion_parameters();
    let req_body = LlamaCompletionRequest {
        prompt,
        temperature,
        n_predict,
        grammar: VERDICT_GRAMMAR,
        logprobs: true,
        n_probs: PROB_WINDOW,
        cache_prompt: true,
        stream: false,
    };

    // 30-second request timeout per call configured on inference client. No retries.
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&req_body)
        .send()
        .await
        .map_err(|e| anyhow!("Inference request to llama-server failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("llama-server error {}: {}", status, body));
    }

    let res_body: LlamaCompletionResponse = response
        .json()
        .await
        .map_err(|e| anyhow!("Failed to parse llama-server response: {}", e))?;
    verdict_margin(&res_body)
}

/// Resolves candidates sequentially by calling loopback llama-server.
pub async fn resolve_spans_via_runtime(
    client: &reqwest::Client,
    port: u16,
    token: &str,
    context: &str,
    spans: &[AutoInputSpan],
) -> Result<Vec<AutoInputDecision>> {
    if spans.is_empty() {
        return Ok(Vec::new());
    }

    // Input validation: Reject requests with duplicate span IDs
    let mut seen_ids = std::collections::HashSet::new();
    for span in spans {
        if !seen_ids.insert(span.id) {
            return Err(anyhow!("Duplicate span ID detected: {}", span.id));
        }
    }

    let url = format!("http://127.0.0.1:{}/completion", port);
    let mut current_context = context.to_owned();
    let mut decisions = Vec::with_capacity(spans.len());

    for span in spans {
        // Fast-path identical representations (e.g. pure numbers or punctuation)
        if span.ko == span.en {
            decisions.push(AutoInputDecision {
                id: span.id,
                language: AutoLanguage::Ko,
            });
            if !current_context.is_empty() {
                current_context.push(' ');
            }
            current_context.push_str(&span.ko);
            continue;
        }

        let (ko_prompt, en_prompt, history_start) =
            fit_verdict_prompt(client, port, token, &current_context, span).await?;
        current_context.drain(..history_start);

        let ko_margin = verdict(client, &url, token, &ko_prompt).await?;
        let en_margin = verdict(client, &url, token, &en_prompt).await?;
        // Ties keep the Korean candidate, matching the identical-candidate
        // fast path above (and the benchmark harness's first-maximum choice).
        let language = if ko_margin >= en_margin {
            AutoLanguage::Ko
        } else {
            AutoLanguage::En
        };

        decisions.push(AutoInputDecision {
            id: span.id,
            language,
        });

        // Append chosen word to contextual accumulation for subsequent spans
        let chosen_word = match language {
            AutoLanguage::Ko => span.ko.as_str(),
            AutoLanguage::En => span.en.as_str(),
        };
        if !current_context.is_empty() {
            current_context.push(' ');
        }
        current_context.push_str(chosen_word);
    }

    Ok(decisions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_margin_prefers_the_accepted_verdict_token() {
        let response = |top: serde_json::Value| LlamaCompletionResponse {
            completion_probabilities: serde_json::from_value(
                serde_json::json!([{"top_logprobs": top}]),
            )
            .unwrap(),
        };
        // Token strings arrive space-prefixed and case-mixed from the tokenizer.
        assert_eq!(
            verdict_margin(&response(serde_json::json!([
                {"token": " Yes", "logprob": -0.5}, {"token": " No", "logprob": -3.0},
            ])))
            .unwrap(),
            2.5
        );
        assert_eq!(
            verdict_margin(&response(serde_json::json!([
                {"token": "yes", "logprob": -4.0}, {"token": "no", "logprob": -1.0},
            ])))
            .unwrap(),
            -3.0
        );
    }

    #[test]
    fn verdict_margin_penalizes_a_missing_no_token() {
        let response: LlamaCompletionResponse = serde_json::from_value(serde_json::json!({
            "content": "yes",
            "completion_probabilities": [{"top_logprobs": [{"token": "yes", "logprob": -1.0}]}],
        }))
        .unwrap();
        assert_eq!(
            verdict_margin(&response).unwrap(),
            -1.0 - ABSENT_VERDICT_LOGPROB
        );
    }

    #[test]
    fn verdict_margin_requires_a_probability_window() {
        let response = LlamaCompletionResponse {
            completion_probabilities: Vec::new(),
        };
        assert!(verdict_margin(&response).is_err());
    }

    /// End-to-end proof against the real pinned runtime, the real vetted model,
    /// and the real bundled dictionaries. Not part of the default suite:
    ///   TAJAGI_LIVE_RUNTIME=…/runtime/llama-server \
    ///   TAJAGI_LIVE_MODEL=…/models/Qwen3-0.6B-Q8_0.gguf \
    ///   cargo test --lib live_verdict_pipeline -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn live_verdict_pipeline_matches_real_inputs() {
        use crate::managers::auto_input::lexicon::lexicon_choice;
        use crate::text_predict::{load_predictor, PredictorState};
        use std::process::{Command, Stdio};

        let runtime = std::env::var("TAJAGI_LIVE_RUNTIME").expect("TAJAGI_LIVE_RUNTIME");
        let model = std::env::var("TAJAGI_LIVE_MODEL").expect("TAJAGI_LIVE_MODEL");
        let resources = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/models");

        let state = PredictorState::new();
        let predictor = load_predictor(
            &resources.join("small_ko.txt.zst"),
            &resources.join("large_en.txt.zst"),
            &state,
        )
        .expect("bundled dictionaries");

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let token = uuid::Uuid::new_v4().to_string();
        let mut child = Command::new(&runtime)
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "--api-key",
                &token,
                "-m",
                &model,
                "-c",
                &RUNTIME_CONTEXT_LIMIT.to_string(),
                "--parallel",
                "1",
                "--jinja",
                "-ngl",
                "99",
                "--no-webui",
            ])
            .current_dir(std::path::Path::new(&runtime).parent().unwrap())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("llama-server starts");

        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            if client
                .get(format!("http://127.0.0.1:{port}/health"))
                .bearer_auth(&token)
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "runtime readiness timeout"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        // Real bilingual typing session, in request order.
        let spans = [
            AutoInputSpan {
                id: 1,
                ko: "안녕하세요".into(),
                en: "dkssudgktpdy".into(),
            },
            AutoInputSpan {
                id: 2,
                ko: "듣샤후".into(),
                en: "meeting".into(),
            },
            AutoInputSpan {
                id: 3,
                ko: "오늘".into(),
                en: "dhsmf".into(),
            },
            AutoInputSpan {
                id: 4,
                ko: "ㄱㄷ퍋ㅈ".into(),
                en: "React".into(),
            },
            AutoInputSpan {
                id: 5,
                ko: "있어요".into(),
                en: "dlTdjdy".into(),
            },
        ];

        // Tier 1 is deterministic and needs no model at all.
        let lexical: Vec<_> = spans
            .iter()
            .map(|span| lexicon_choice(&predictor, span))
            .collect();
        println!("lexicon: {:?}", lexical);
        assert_eq!(lexical[1], Some(AutoLanguage::En));
        assert_eq!(lexical[2], Some(AutoLanguage::Ko));
        assert_eq!(lexical[3], Some(AutoLanguage::En));
        assert_eq!(lexical[0], None);
        assert_eq!(lexical[4], None);

        // Tier 2 runs the ambiguous spans through the real runtime.
        let pending: Vec<_> = spans
            .iter()
            .filter(|span| lexicon_choice(&predictor, span).is_none())
            .cloned()
            .collect();
        let decisions = resolve_spans_via_runtime(&client, port, &token, "", &pending)
            .await
            .expect("live inference");
        println!("model: {:?}", decisions);
        assert_eq!(decisions.len(), pending.len());
        assert_eq!(decisions[0].language, AutoLanguage::Ko); // 안녕하세요
        assert_eq!(decisions[1].language, AutoLanguage::Ko); // 있어요

        let _ = child.kill();
        let _ = child.wait();
    }

    async fn tokenizer_server() -> (
        u16,
        tokio::sync::mpsc::UnboundedReceiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    let header_end = loop {
                        let byte = socket.read_u8().await.unwrap();
                        bytes.push(byte);
                        if bytes.ends_with(b"\r\n\r\n") {
                            break bytes.len();
                        }
                    };
                    let header = String::from_utf8_lossy(&bytes);
                    let length: usize = header
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    let tokenize = header.starts_with("POST /tokenize ");
                    bytes.resize(header_end + length, 0);
                    socket.read_exact(&mut bytes[header_end..]).await.unwrap();
                    let request: serde_json::Value =
                        serde_json::from_slice(&bytes[header_end..]).unwrap();
                    let body = if tokenize {
                        let content = request["content"].as_str().unwrap();
                        serde_json::json!({"tokens": vec![0; content.chars().count() + 1]})
                    } else {
                        let prompt = request["prompt"].as_str().unwrap();
                        tx.send(prompt.to_owned()).unwrap();
                        // Accept the Korean candidate (margin +2), reject the English
                        // one (margin -2), so the expected decision is deterministic.
                        let (yes, no) = if prompt.contains("Korean") {
                            (0.0, -2.0)
                        } else {
                            (-2.0, 0.0)
                        };
                        let content = if yes > no { "yes" } else { "no" };
                        serde_json::json!({
                            "content": content,
                            "completion_probabilities": [{
                                "top_logprobs": [
                                    {"token": " yes", "logprob": yes},
                                    {"token": "no", "logprob": no},
                                ],
                            }],
                        })
                    }
                    .to_string();
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body,
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        (port, rx, server)
    }

    #[tokio::test]
    async fn rolling_history_fits_actual_full_prompt_without_clipping_candidates() {
        let (port, mut prompts, server) = tokenizer_server().await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let context = format!("{}RECENT HISTORY", "old history ".repeat(1000));
        let spans = [
            AutoInputSpan {
                id: 1,
                ko: "  오늘!  ".into(),
                en: "  today!  ".into(),
            },
            AutoInputSpan {
                id: 2,
                ko: "회의".into(),
                en: "meeting".into(),
            },
        ];
        let decisions = resolve_spans_via_runtime(&client, port, "token", &context, &spans)
            .await
            .unwrap();
        assert_eq!(
            decisions,
            vec![
                AutoInputDecision {
                    id: 1,
                    language: AutoLanguage::Ko
                },
                AutoInputDecision {
                    id: 2,
                    language: AutoLanguage::Ko
                },
            ]
        );
        // Each span is judged twice, Korean candidate first, on its own.
        let first = prompts.recv().await.unwrap();
        assert!(first.contains("RECENT HISTORY"));
        assert!(first.contains("Korean"));
        assert!(first.contains("  오늘!  "));
        let second = prompts.recv().await.unwrap();
        assert!(second.contains("English"));
        assert!(second.contains("  today!  "));
        // The chosen surface text carries into the next span's history.
        let third = prompts.recv().await.unwrap();
        assert!(third.contains("  오늘!  "));
        assert!(third.contains("회의"));
        let fourth = prompts.recv().await.unwrap();
        assert!(fourth.contains("meeting"));
        for prompt in [first, second, third, fourth] {
            assert!(
                prompt.chars().count() + 1 + OUTPUT_TOKENS + SAFETY_MARGIN <= RUNTIME_CONTEXT_LIMIT
            );
        }
        server.abort();
    }

    #[tokio::test]
    async fn over_budget_candidates_fail_before_completion() {
        let (port, mut prompts, server) = tokenizer_server().await;
        let span = AutoInputSpan {
            id: 7,
            ko: "가".repeat(2048),
            en: "a".repeat(2048),
        };
        let result = resolve_spans_via_runtime(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            port,
            "token",
            "history",
            &[span],
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("Span 7"));
        assert!(prompts.try_recv().is_err());
        server.abort();
    }

    #[tokio::test]
    async fn tokenizer_errors_are_not_replaced_with_estimates() {
        assert!(count_tokens(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            0,
            "",
            "candidate",
        )
        .await
        .is_err());
    }
}
