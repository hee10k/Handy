# Bundled local text-prediction dictionaries (offline)

These files power Tajagi's local typo correction and inline autocomplete.
**No network, no LLM — everything runs on-device.**

| File | Contents | Source |
|------|----------|--------|
| `small_ko.txt.zst` | Korean word log-frequencies (29,988 words) | [wordfreq-rs models-v1](https://github.com/kampersanda/wordfreq-rs/releases/tag/models-v1) |
| `large_en.txt.zst` | English word log-frequencies (321,180 words) | [wordfreq-rs models-v1](https://github.com/kampersanda/wordfreq-rs/releases/tag/models-v1) |

Files are stored zstd-compressed and decompressed once on first use into an
in-memory SymSpell + prefix index.

## License / attribution

The data derives from the [wordfreq](https://github.com/rspeer/wordfreq) corpus
(Francis Bond / Robyn Speer) and is distributed under **CC-BY-SA-4.0**
(attribution + share-alike). The wordfreq model snapshot is circa 2021.

We bundle the wordfreq model files verbatim (unmodified, only zstd-compressed)
with this attribution. The Tajagi application code itself remains under the
fork's license (MIT, see LICENSE).