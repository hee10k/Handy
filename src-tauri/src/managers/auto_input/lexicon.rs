//! Deterministic lexicon tier for bilingual span resolution.
//!
//! A span is decided without any model when exactly one of its two
//! interpretations is a word in the bundled wordfreq dictionaries. Measured on
//! 2026-10-12 over 79 validated bilingual units: 67 spans resolved (85%
//! coverage) with 0 wrong resolutions. The remaining spans (real collisions
//! such as `to` → `새`, out-of-dictionary inflections, literal affixes) are left
//! to the local model, which is why the runtime is an optional enhancement
//! rather than a requirement for auto mode.

use super::resolver::{AutoInputSpan, AutoLanguage};
use crate::text_predict::TextPredictor;

/// The dictionary-lookup core of a candidate: ASCII letters and precomposed
/// Hangul syllables only. Digits, punctuation, and untouched compatibility jamo
/// decorate the word but do not decide its language.
fn dictionary_core(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_alphabetic() || ('\u{ac00}'..='\u{d7a3}').contains(c))
        .collect()
}

/// Whether the candidate's letters form a known Korean/English dictionary word.
fn is_known_word(predictor: &TextPredictor, text: &str) -> bool {
    let core = dictionary_core(text);
    !core.is_empty() && predictor.contains(&core)
}

/// Decides a span from the lexicon alone, or `None` when both interpretations
/// are plausible and context is required.
pub fn lexicon_choice(predictor: &TextPredictor, span: &AutoInputSpan) -> Option<AutoLanguage> {
    if span.ko == span.en {
        return Some(AutoLanguage::Ko);
    }
    match (
        is_known_word(predictor, &span.ko),
        is_known_word(predictor, &span.en),
    ) {
        (true, false) => Some(AutoLanguage::Ko),
        (false, true) => Some(AutoLanguage::En),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Mirrors the bundled `wordfreq` format: `word <log10 probability>`.
    const DICTIONARY: &str = "오늘 -3.1\n한글 -3.4\n회의 -4.0\n내일 -3.9\n\
                              today -3.2\nmeeting -3.5\nhello -3.0\nreact -3.6\n";

    fn predictor() -> TextPredictor {
        TextPredictor::from_dictionary(DICTIONARY)
    }

    fn span(ko: &str, en: &str) -> AutoInputSpan {
        AutoInputSpan {
            id: 1,
            ko: ko.into(),
            en: en.into(),
        }
    }

    #[test]
    fn known_korean_against_gibberish_literal_resolves_korean() {
        assert_eq!(
            lexicon_choice(&predictor(), &span("오늘", "dhsmf")),
            Some(AutoLanguage::Ko)
        );
    }

    #[test]
    fn known_english_against_gibberish_hangul_resolves_english() {
        assert_eq!(
            lexicon_choice(&predictor(), &span("듣샤후", "meeting")),
            Some(AutoLanguage::En)
        );
    }

    #[test]
    fn technical_names_are_preserved_as_english() {
        assert_eq!(
            lexicon_choice(&predictor(), &span("ㄱㄷ퍋ㅈ", "React")),
            Some(AutoLanguage::En)
        );
    }

    #[test]
    fn words_in_both_lexicons_need_context() {
        // `so` is a real English word and `내` is a real Korean word.
        let predictor = TextPredictor::from_dictionary("내 -3.0\nso -3.1\n");
        assert_eq!(lexicon_choice(&predictor, &span("내", "so")), None);
    }

    #[test]
    fn dictionary_misses_need_context() {
        assert_eq!(
            lexicon_choice(&predictor(), &span("안녕하세요", "dkssudgktpdy")),
            None
        );
    }

    #[test]
    fn identical_representations_are_decided_immediately() {
        assert_eq!(
            lexicon_choice(&predictor(), &span("2024!?", "2024!?")),
            Some(AutoLanguage::Ko)
        );
    }

    #[test]
    fn literal_affixes_do_not_prevent_a_dictionary_hit() {
        assert_eq!(
            lexicon_choice(&predictor(), &span("한글!?12", "gksrmf!?12")),
            Some(AutoLanguage::Ko)
        );
        assert_eq!(
            lexicon_choice(&predictor(), &span("되ㅣㅐ!?12", "hello!?12")),
            Some(AutoLanguage::En)
        );
    }
}
