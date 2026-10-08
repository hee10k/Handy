//! Local typo correction + inline word autocomplete.
//!
//! No LLM, no network. Two bundled wordfreq dictionaries (the `wordfreq-rs`
//! model files, CC-BY-SA-4.0 — see `resources/models/README.md`) are stored
//! zstd-compressed in tauri resources, decompressed once on first use, and
//! indexed two ways:
//!   * **SymSpell** (edit-distance + frequency) for typo correction — given a
//!     sentence it proposes a corrected sentence by replacing unknown tokens
//!     with their best dictionary candidate.
//!   * a frequency-ordered prefix index for inline autocomplete — given the
//!     partial word the user is typing, suggest dictionary words sharing that
//!     prefix, ranked by frequency.
//!
//! Both paths are pure and unit-testable against an inline dictionary string.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, RwLock};

use serde::Serialize;
use specta::Type;
use symspell_rs::{SymSpell, Verbosity};
use tauri::Manager;

/// Upper bound on how many of the most-frequent dictionary words are indexed.
/// Trades a little recall for a much smaller SymSpell delete index (build time
/// and memory). 150k covers the vast majority of everyday English + Korean.
const MAX_INDEXED_WORDS: usize = 150_000;

/// One line of a continuation suggestion in the composer's bottom panel.
/// `source` is `bm25` | `prob` (local, always present) or `ai` (on-demand LLM).
#[derive(Serialize, Type, Clone, Debug)]
pub struct ContinuationSuggestion {
    pub source: &'static str,
    pub text: String,
    pub score: f32,
}

/// A ready-to-query text predictor. Built once from a dictionary and shared.
pub struct TextPredictor {
    /// Words sorted ascending by UTF-8 bytes, for binary-searched prefix range.
    prefix_sorted: Vec<String>,
    /// word -> frequency rank (0 = most common); used to order completions.
    freq_rank: HashMap<String, usize>,
    /// Edit-distance corrector over the same vocabulary.
    spell: SymSpell,
    /// Character-bigram -> document frequency, for word-based BM25 scoring.
    bigram_df: HashMap<String, u32>,
    /// Total indexed words (document count for BM25 idf).
    doc_count: u32,
}

/// Parses wordfreq-format dictionary lines (`word <log10 probability>`) into
/// `(word, log10_frequency)`, sorted by frequency descending (most common first).
fn parse_freq_dictionary(dict: &str) -> Vec<(String, f64)> {
    let mut words: Vec<(String, f64)> = Vec::new();
    for line in dict.lines() {
        let mut it = line.split_whitespace();
        let Some(word) = it.next() else {
            continue;
        };
        if word.is_empty() {
            continue;
        }
        let freq = it.next().and_then(|f| f.parse::<f64>().ok()).unwrap_or(0.0);
        words.push((word.to_string(), freq));
    }
    // wordfreq files are already frequency-sorted, but re-sort defensively (and
    // use a stable sort so equal frequencies keep line order).
    words.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    words
}

/// Common Korean particles/josa that attach to nouns. If the suggested fix only
/// strips one of these, the token is a legitimate inflected form (not a typo).
const KOREAN_PARTICLES: &[&str] = &[
    "은", "는", "이", "가", "을", "를", "도", "만", "까", "의", "에", "와", "과", "로", "으로",
    "에서", "부터", "까지", "처럼", "만큼", "하고", "이랑", "랑", "하고", "요",
];

fn is_korean_token(word: &str) -> bool {
    word.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c))
}

/// Overlapping character bigrams of a string (used for word-based BM25).
fn char_bigrams(s: &str) -> Vec<String> {
    let chars: Vec<char> = s.chars().collect();
    chars.windows(2).map(|w| w.iter().collect()).collect()
}

/// Common Korean/English continuers used when the sentence is already complete
/// (no in-progress word) so there is still a local "keep writing" suggestion.
const KOREAN_CONNECTORS: &[&str] = &[
    "그리고",
    "또한",
    "하지만",
    "그래서",
    "그런데",
    "다음으로",
    "반면에",
    "따라서",
];
const ENGLISH_CONNECTORS: &[&str] = &[
    "and",
    "but",
    "so",
    "also",
    "then",
    "next",
    "however",
    "therefore",
    "moreover",
];

/// A trailing sentence terminator means the next suggestion must continue the
/// draft, even when the user has not typed a space after the punctuation yet.
fn ends_sentence(text: &str) -> bool {
    matches!(
        text.trim_end().chars().last(),
        Some('.' | '!' | '?' | '。' | '！' | '？')
    )
}

/// Dominant script of a draft: Korean when it contains any Hangul syllable,
/// otherwise English (used to pick language-appropriate connectors).
fn draft_script(text: &str) -> Script {
    if text.chars().any(|c| ('\u{AC00}'..='\u{D7A3}').contains(&c)) {
        Script::Ko
    } else {
        Script::En
    }
}

enum Script {
    Ko,
    En,
}

/// True when `token` == `suggestion` + exactly one particle suffix (non-empty).
fn is_particle_suffix(token: &str, suggestion: &str) -> bool {
    if !token.starts_with(suggestion) || token.len() <= suggestion.len() {
        return false;
    }
    let suffix = &token[suggestion.len()..];
    KOREAN_PARTICLES.contains(&suffix)
}

impl TextPredictor {
    /// Build an index from wordfreq-format text (`word <log10 probability>`).
    /// Frequency order is preserved (most common first).
    pub fn from_dictionary(dict: &str) -> Self {
        let mut parsed = parse_freq_dictionary(dict);
        if parsed.is_empty() {
            return Self {
                prefix_sorted: Vec::new(),
                freq_rank: HashMap::new(),
                spell: SymSpell::new(1, None, 7, 1),
                bigram_df: HashMap::new(),
                doc_count: 0,
            };
        }
        let freq_order: Vec<String> = parsed.drain(..).map(|(w, _)| w).collect();
        // Cap to the most frequent words: rare entries only add index build time
        // and correction noise. SymSpell's delete index grows superlinearly, so
        // this keeps first-use latency (and memory) reasonable.
        let cap = MAX_INDEXED_WORDS.min(freq_order.len());
        let freq_order: Vec<String> = freq_order.into_iter().take(cap).collect();
        let mut prefix_sorted = freq_order.clone();
        prefix_sorted.sort(); // UTF-8 byte order == prefix-consistent ordering
        let freq_rank: HashMap<String, usize> = freq_order
            .iter()
            .enumerate()
            .map(|(i, w)| (w.clone(), i))
            .collect();

        // No per-length threshold: short terms (e.g. 3-char Korean eojeol) must
        // be correctable. max_dictionary_edit_distance = 1 keeps the delete
        // index small (fast build) while covering the large majority of typos.
        let mut spell = SymSpell::new(1, None, 7, 1);
        // Give more common words a higher count so SymSpell ranks them first on tie.
        let n = freq_order.len();
        for (i, w) in freq_order.iter().enumerate() {
            spell.create_dictionary_entry(w.clone(), n - i);
        }

        // Character-bigram document frequencies for word-based BM25 scoring.
        let doc_count = freq_order.len() as u32;
        let mut bigram_df: HashMap<String, u32> = HashMap::new();
        for w in &freq_order {
            let mut seen: Vec<String> = char_bigrams(w);
            seen.sort();
            seen.dedup();
            for b in seen {
                *bigram_df.entry(b).or_insert(0) += 1;
            }
        }

        Self {
            prefix_sorted,
            freq_rank,
            spell,
            bigram_df,
            doc_count,
        }
    }

    /// Whether the exact (lowercased) word is in the dictionary.
    pub fn contains(&self, word: &str) -> bool {
        !word.is_empty() && self.freq_rank.contains_key(&word.to_lowercase())
    }

    /// Correct the best token of `word` via SymSpell. `None` when no confident
    /// correction exists (word in dictionary, too short, or no close match).
    fn correct_word(&self, word: &str, max_distance: usize) -> Option<String> {
        let normalized = word.to_lowercase();
        if self.contains(&normalized) {
            return None;
        }
        // Guard against correcting trivial tokens and pure punctuation/numbers.
        let meaningful: Vec<char> = normalized.chars().filter(|c| c.is_alphanumeric()).collect();
        if meaningful.len() < self.min_correctable_len(normalized.chars().count()) {
            return None;
        }
        if normalized
            .chars()
            .all(|c| c.is_numeric() || c.is_ascii_punctuation())
        {
            return None;
        }
        let suggestions = self.spell.lookup(
            &normalized,
            Verbosity::Top,
            max_distance,
            &None,
            Some(1),
            false,
        );
        let s = suggestions.first()?;
        if s.distance == 0 {
            return None; // already correct
        }
        if s.distance > max_distance || s.term.is_empty() {
            return None;
        }
        // Korean particle guard: Korean is highly inflectional, so most valid
        // eojeol are NOT exact dictionary words. If the suggestion only differs
        // by dropping a trailing particle/josa (e.g. 오늘은 → 오늘), it is a
        // legitimate inflected form, not a typo — leave it alone.
        if is_korean_token(&normalized) && is_particle_suffix(&normalized, &s.term) {
            return None;
        }
        Some(s.term.clone())
    }

    /// Minimum token length eligible for correction (edit-distance reliability).
    fn min_correctable_len(&self, chars: usize) -> usize {
        match chars {
            ..=2 => 4, // too short to trust edit distance
            _ => 3,
        }
    }

    /// Propose a corrected sentence by replacing each unknown, confident typo
    /// with its best dictionary candidate. Returns `None` when nothing changes.
    /// Tokenization is whitespace-based (covers Korean eojeol and English
    /// words), preserving each token's original case and punctuation.
    pub fn correct_sentence(&self, text: &str, max_distance: usize) -> Option<String> {
        let mut changed = false;
        let mut out = String::with_capacity(text.len());
        for token in text.split_whitespace() {
            if !out.is_empty() {
                out.push(' ');
            }
            if let Some(corrected) = self.correct_word(token, max_distance) {
                changed = true;
                // Preserve original leading/trailing punctuation.
                let before: String = token.chars().take_while(|c| !c.is_alphanumeric()).collect();
                let after: String = token
                    .chars()
                    .rev()
                    .take_while(|c| !c.is_alphanumeric())
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect();
                out.push_str(&before);
                out.push_str(&corrected);
                out.push_str(&after);
            } else {
                out.push_str(token);
            }
        }
        changed.then_some(out)
    }

    /// Dictionary words sharing `prefix` (byte-ordered prefix scan), paired with
    /// their frequency rank (lower = more common), up to `max`.
    fn prefix_matches<'a>(&'a self, prefix: &str, max: usize) -> Vec<(usize, &'a str)> {
        if prefix.is_empty() {
            return Vec::new();
        }
        let lo = self
            .prefix_sorted
            .partition_point(|w| w.as_bytes() < prefix.as_bytes());
        let mut hi_guard = prefix.as_bytes().to_vec();
        hi_guard.push(0xFF);
        let hi_guard = String::from_utf8_lossy(&hi_guard);
        let hi = self
            .prefix_sorted
            .partition_point(|w| w.as_bytes() < hi_guard.as_bytes());
        self.prefix_sorted[lo..hi]
            .iter()
            .filter(|w| w.starts_with(prefix))
            .take(max)
            .map(|w| {
                (
                    self.freq_rank.get(w).copied().unwrap_or(usize::MAX),
                    w.as_str(),
                )
            })
            .collect()
    }

    /// Word-based BM25 score of `word` against the sentence's char-bigrams.
    fn bm25_score(&self, word: &str, query_bigrams: &[String]) -> f32 {
        const K1: f32 = 1.5;
        const B: f32 = 0.75;
        const AVG_DOC_LEN: f32 = 6.5;
        let dl = word.chars().count() as f32;
        let word_bigrams = char_bigrams(word);
        let mut score = 0.0f32;
        for q in query_bigrams {
            let df = self.bigram_df.get(q).copied().unwrap_or(0);
            if df == 0 {
                continue;
            }
            let n = self.doc_count as f32;
            let idf = ((n - df as f32 + 0.5) / (df as f32 + 0.5) + 1.0).ln();
            let tf = word_bigrams.iter().filter(|b| *b == q).count() as f32;
            let denom = tf + K1 * (1.0 - B + B * dl / AVG_DOC_LEN);
            score += idf * (tf * (K1 + 1.0)) / denom;
        }
        score
    }

    /// Up to 5 local continuation lines (`prob` + `bm25`) for the current
    /// draft. When a word is in progress, `prob` lines are the top-frequency
    /// strictly-longer prefix completions (the bare partial word is excluded)
    /// and `bm25` lines are the best lexical-overlap variants for diversity.
    /// When the sentence is complete, both fall back to common connectors.
    /// Deduped across sources (prob wins), capped at 5. Smoothes into the
    /// composer's bottom panel alongside on-demand LLM lines.
    pub fn continuation_candidates(&self, text: &str) -> Vec<ContinuationSuggestion> {
        let lower = text.to_lowercase();
        if lower.trim().is_empty() {
            return Vec::new();
        }
        let tokens: Vec<&str> = lower.split_whitespace().collect();
        let ends_in_word = !lower.ends_with(' ')
            && !lower.ends_with('\n')
            && !lower.ends_with('\t')
            && !ends_sentence(&lower);
        let prefix = if ends_in_word {
            tokens.last().copied().unwrap_or("").to_string()
        } else {
            String::new()
        };
        let query_bigrams = char_bigrams(&lower);
        let mut out: Vec<ContinuationSuggestion> = Vec::new();

        if !prefix.is_empty() {
            // Strictly-longer prefix completions, by frequency.
            let mut matches: Vec<(usize, &str)> = self
                .prefix_matches(&prefix, 256)
                .into_iter()
                .filter(|(_, w)| *w != prefix.as_str() && w.len() > prefix.len())
                .collect();
            matches.sort_by_key(|(r, w)| (*r, std::cmp::Reverse(w.chars().count())));

            // One probability candidate: the most frequent longer completion;
            // when none exists, the exact dictionary word commits the token.
            let prob = matches.first().map(|(_, word)| *word).or_else(|| {
                self.freq_rank
                    .contains_key(prefix.as_str())
                    .then_some(prefix.as_str())
            });
            if let Some(word) = prob {
                let rank = self.freq_rank.get(word).copied().unwrap_or(usize::MAX);
                out.push(ContinuationSuggestion {
                    source: "prob",
                    text: word.to_string(),
                    score: 1.0 - (rank as f32 / 1_000_000.0),
                });
            }

            // One BM25 candidate, distinct from the frequency pick. A sparse
            // prefix can use the exact dictionary word to close the token.
            let bm25 = matches
                .iter()
                .filter(|(_, word)| Some(*word) != prob)
                .map(|(_, word)| (self.bm25_score(word, &query_bigrams), *word))
                .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
                .or_else(|| {
                    self.freq_rank
                        .contains_key(prefix.as_str())
                        .then_some((0.0, prefix.as_str()))
                });
            if let Some((score, word)) = bm25 {
                out.push(ContinuationSuggestion {
                    source: "bm25",
                    text: word.to_string(),
                    score,
                });
            }
        } else {
            // Sentence complete: continuers in the draft's script (no cross-script
            // mixing — an English draft never sees Korean connectors). Falls
            // back to the other script only when the dict has none of the
            // preferred ones.
            let (primary, fallback) = match draft_script(&lower) {
                Script::Ko => (&KOREAN_CONNECTORS[..], &ENGLISH_CONNECTORS[..]),
                Script::En => (&ENGLISH_CONNECTORS[..], &KOREAN_CONNECTORS[..]),
            };
            let mut present: Vec<&str> = primary
                .iter()
                .copied()
                .filter(|c| self.freq_rank.contains_key(*c))
                .collect();
            if present.is_empty() {
                present = fallback
                    .iter()
                    .copied()
                    .filter(|c| self.freq_rank.contains_key(*c))
                    .collect();
            }
            // Exactly one probability connector and one distinct BM25 connector
            // keep the panel's local rows meaningful and source-labeled.
            let prob = present.first().copied();
            if let Some(connector) = prob {
                let rank = self.freq_rank.get(connector).copied().unwrap_or(usize::MAX);
                out.push(ContinuationSuggestion {
                    source: "prob",
                    text: connector.to_string(),
                    score: 1.0 - (rank as f32 / 1_000_000.0),
                });
            }
            if let Some(connector) = present
                .iter()
                .copied()
                .filter(|connector| Some(*connector) != prob)
                .max_by(|a, b| {
                    self.bm25_score(a, &query_bigrams)
                        .partial_cmp(&self.bm25_score(b, &query_bigrams))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            {
                out.push(ContinuationSuggestion {
                    source: "bm25",
                    text: connector.to_string(),
                    score: self.bm25_score(connector, &query_bigrams),
                });
            }
        }
        // Dedupe (prob wins) and cap at 5.
        let mut seen = std::collections::HashSet::new();
        out.retain(|s| seen.insert(s.text.clone()));
        out.truncate(5);
        out
    }
}

/// Lazy, shared predictor built from bundled resources on first use.
pub struct PredictorState(pub RwLock<Option<Arc<TextPredictor>>>);

impl PredictorState {
    pub fn new() -> Self {
        Self(RwLock::new(None))
    }
}

/// Load (once) and return the predictor, decompressing the bundled dictionaries
/// at the resolved resource paths (ko then en). Both are required.
pub(crate) fn load_predictor(
    korean_path: &Path,
    english_path: &Path,
    state: &PredictorState,
) -> Result<Arc<TextPredictor>, String> {
    if let Ok(guard) = state.0.read() {
        if let Some(p) = guard.as_ref() {
            return Ok(p.clone());
        }
    }
    // Build outside the write lock to avoid holding it during decompression.
    let mut dict = decompress_zstd(korean_path)?;
    dict.push('\n');
    dict.push_str(&decompress_zstd(english_path)?);
    let predictor = Arc::new(TextPredictor::from_dictionary(&dict));
    if let Ok(mut guard) = state.0.write() {
        *guard = Some(predictor.clone());
    }
    Ok(predictor)
}

fn decompress_zstd(path: &Path) -> Result<String, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("Cannot read model '{}': {e}", path.display()))?;
    let mut decoder = zstd::stream::read::Decoder::new(&bytes[..])
        .map_err(|e| format!("Cannot open zstd stream '{}': {e}", path.display()))?;
    let mut out = String::new();
    use std::io::Read;
    decoder
        .read_to_string(&mut out)
        .map_err(|e| format!("Cannot decode zstd model '{}': {e}", path.display()))?;
    Ok(out)
}

/// Correct obvious typos in `text`, returning the corrected sentence (or `None`
/// when it is already clean). Purely local — the bundled wordfreq dictionaries.
#[tauri::command]
#[specta::specta]
pub fn correct_text(
    app: tauri::AppHandle,
    state: tauri::State<'_, PredictorState>,
    text: String,
) -> Result<Option<String>, String> {
    let resolve = |rel: &str| {
        app.path()
            .resolve(rel, tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("Cannot locate bundled dictionary '{rel}': {e}"))
    };
    let ko = resolve("models/small_ko.txt.zst")?;
    let en = resolve("models/large_en.txt.zst")?;
    let predictor = load_predictor(&ko, &en, &state)?;
    Ok(predictor.correct_sentence(&text, 1))
}

/// panel — pure dictionary/BM25, instant and offline. Model continuations are
/// a separate, explicit command (`transform::suggest_llm_continuations`).
#[tauri::command]
#[specta::specta]
pub fn get_continuation_suggestions(
    app: tauri::AppHandle,
    state: tauri::State<'_, PredictorState>,
    text: String,
) -> Result<Vec<ContinuationSuggestion>, String> {
    let resolve = |rel: &str| {
        app.path()
            .resolve(rel, tauri::path::BaseDirectory::Resource)
            .map_err(|e| format!("Cannot locate bundled dictionary '{rel}': {e}"))
    };
    let ko = resolve("models/small_ko.txt.zst")?;
    let en = resolve("models/large_en.txt.zst")?;
    let predictor = load_predictor(&ko, &en, &state)?;
    Ok(predictor.continuation_candidates(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny inline dictionary: frequency order = most common first.
    const DICT: &str = "I 0.06\nthe 0.05\nand 0.04\ncan 0.03\nthis 0.02\n\
        handle 0.001\nhand 0.002\nhanbok 0.0001\n\
        자전거 0.01\n자전차 0.005\n자전 0.004\n자치 0.003\n컴퓨터 0.02\n컴퓨터학과 0.001\n서울 0.01\n";

    fn predictor() -> TextPredictor {
        TextPredictor::from_dictionary(DICT)
    }

    #[test]
    fn parses_frequency_dict_and_orders() {
        let p = predictor();
        assert!(p.contains("handle"));
        assert!(p.contains("자전거"));
        assert!(!p.contains("zzzz"));
        // Most frequent first: "I" (0.06) outranks "the" (0.05).
        assert!(p.freq_rank["I"] < p.freq_rank["the"]);
    }

    #[test]
    fn correction_fixes_english_typo() {
        let p = predictor();
        let out = p.correct_sentence("I can haandle this", 1);
        assert_eq!(out.as_deref(), Some("I can handle this"));
    }

    #[test]
    fn correction_fixes_korean_typo() {
        let p = predictor();
        let out = p.correct_sentence("자젼거  타고가요", 1);
        // 자젼거 → 자전거
        let corrected = out.unwrap();
        assert!(corrected.contains("자전거"), "got {corrected}");
    }

    #[test]
    fn no_change_yields_none() {
        let p = predictor();
        assert!(p.correct_sentence("이건 정상 문장", 1).is_none());
        assert!(p.correct_sentence("the and hand", 1).is_none());
    }

    #[test]
    fn short_and_scalar_tokens_untouched() {
        let p = predictor();
        // "hi" is too short to correct, numbers untouched.
        let out = p.correct_sentence("hi 123 abc!!", 1);
        assert!(out.is_none() || out.as_deref() == Some("hi 123 abc!!"));
    }

    #[test]
    fn korean_particle_inflections_not_wrongly_corrected() {
        let p = predictor();
        // "컴퓨터" is in the dict; "컴퓨터는" (noun + particle) must NOT become
        // "컴퓨터" — the guard treats it as a legitimate inflected form.
        let out = p.correct_sentence("컴퓨터는", 1);
        assert!(out.is_none(), "got {out:?}");
    }

    #[test]
    fn continuation_returns_probability_and_bm25_lines() {
        let p = predictor();
        let mid = p.continuation_candidates("나는 자전");
        assert!(
            mid.iter().any(|s| s.source == "prob" && s.text == "자전거"),
            "prob should complete 자전: {mid:?}"
        );
        let bm25 = mid
            .iter()
            .find(|s| s.source == "bm25")
            .expect("BM25 should offer a second local candidate");
        assert_ne!(bm25.text, "자전거", "BM25 must differ from probability");
        assert!(mid.len() <= 5);

        let full = p.continuation_candidates("이제 시작하겠습니다 ");
        assert!(
            !full.is_empty() && full[0].source == "prob",
            "prob connector: {full:?}"
        );
        assert!(p.continuation_candidates("").is_empty());
        let punctuated = p.continuation_candidates("I can handle this.");
        assert!(
            punctuated.iter().any(|s| s.source == "prob"),
            "punctuated draft should continue: {punctuated:?}"
        );
    }

    /// Builds the index from the actual bundled dictionaries. This intentionally
    /// stays opt-in because resource decompression and indexing take seconds.
    #[test]
    #[ignore]
    fn real_dictionaries_build_and_work() {
        let ko =
            decompress_zstd(Path::new("resources/models/small_ko.txt.zst")).expect("korean dict");
        let en =
            decompress_zstd(Path::new("resources/models/large_en.txt.zst")).expect("english dict");
        let p = TextPredictor::from_dictionary(&format!("{ko}\n{en}"));
        let corrected = p.correct_sentence("I can haandle this issue", 1);
        assert_eq!(corrected.as_deref(), Some("I can handle this issue"));
        let mid = p.continuation_candidates("나는 자전");
        assert!(mid.iter().any(|s| s.source == "prob" && s.text == "자전거"));
        assert!(mid.iter().any(|s| s.source == "bm25"));
    }
}
