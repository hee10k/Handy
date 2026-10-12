# 13 — 자동 한영 입력: 단어 단위 자동 언어 판별 (automatic bilingual input)

**What to build:** 사용자가 한/영 전환 없이 타이핑하면 컴포저가 단어(span) 단위로 한국어/영어를 **자동 판별**해 초안에 반영한다. 판별은 (1) 번들 사전 기반 결정적 계층 → (2) 로컬 모델의 후보별 독립 판정 순으로 수행하고, 사용자는 언제든 span을 클릭하거나 1/2로 뒤집을 수 있다. 로컬 모델은 타자기 설정에서 검색·다운로드·취소·삭제·로드/언로드한다.

**Blocked by:** 10 (dual-language input)

**Status:** implemented (2026-10-13) — GUI 스모크 1건 잔여(아래 "남은 검증" 참조)

출처: 프롬프트 이력 `history.db` 1484 (`2026-10-12 21:09:20`) — "세 번째 자동입력", 기본 모델은 로컬 모델 + 검색·다운로드 UI.

---

## 확정 설계

- **2계층 판별** (`managers/auto_input/mod.rs::resolve`)
  1. **어휘 계층(결정적, 모델 불필요)**: 번들 wordfreq 사전(`small_ko.txt.zst` + `large_en.txt.zst`, 앱 시작 시 이미 워밍됨)으로 후보별 등재 여부 확인. 한 후보만 등재되면 그 언어로 확정(0ms).
  2. **모델 계층**: 어휘 계층이 결정하지 못한 span만 로컬 모델에 넘긴다. 후보마다 **독립 yes/no 판정**을 요청하고 `logP(yes) − logP(no)` margin을 비교해 큰 쪽을 선택(동률은 Ko, 동일 후보 fast-path와 일치).
- **A/B 단일 선택 프롬프트 폐기**: "후보 1/2 중 고르기"는 (a) 선택지 순서에 붙는 편향, (b) 원시 키와 같은 후보로 쏠리는 literal-match 편향을 만든다. 독립 판정은 둘 다 제거한다(아래 실측).
- **모델은 후보별 1토큰 greedy + grammar 제약**: `root ::= "yes" | "no"`, `temperature 0`, `n_predict 1`, `logprobs true, n_probs 20`, `/completion` 직접 호출. 응답은 `completion_probabilities[0].top_logprobs[].{token,logprob}`(llama.cpp b11429) — 토큰은 공백 접두/대소문자 변동을 정규화하고, no가 윈도우 밖이면 `-30.0`(하네스와 동일).
- **프롬프트 템플릿** `qwen3-0.6b-independent-verdict-v1`: `Is "<후보>" a natural, correctly spelled {Korean|English} word that a person would intend to type here?` + 롤링 히스토리 컨텍스트 + `Answer yes or no, nothing else.`
- **컨텍스트 예산**: `RUNTIME_CONTEXT_LIMIT` 2048 − 출력 1 − 안전 32. **양쪽 후보 프롬프트가 모두** 토큰 예산을 통과해야 하며, 초과 시 히스토리만 이진 탐색으로 트리밍하고 후보 텍스트는 절대 자르지 않는다(초과 시 사용자에게 분할/수동 선택 안내 에러).
- **기본 모델 = `qwen3-0.6b-q8`** (Qwen3-0.6B-Q8_0, 639,446,688 B, `sha256 9465e63a…b031`, HF revision `23749fef…`). 카탈로그 항목은 이 하나뿐이며 `resources/auto-input/models.json`에 있다.
- **런타임**: 공식 llama.cpp **b11429** 프리빌트를 OS/arch별로 다운로드(`runtime.rs::RUNTIME_ASSETS`), sha256 검증 → 스테이징 추출 → `llama-server --version` 검증 → 원자적 설치. 스폰 인자: `--host 127.0.0.1 --port <ephemeral> --api-key <uuid> -m <model> -c 2048 --parallel 1 --jinja -ngl 99 --no-webui`. readiness는 `/health` + Bearer(30s).
- **인터페이스(8 커맨드 / 3 이벤트)**: `get_auto_input_models`, `get_auto_input_state`, `download_auto_input_model`, `cancel_auto_input_model_download`, `delete_auto_input_model`, `set_auto_input_model`, `set_auto_input_enabled`, `resolve_auto_input`. `resolve` 반환은 `Vec<{id, language: "ko"|"en"}>`.
- **IPC는 생성된 `src/bindings.ts` 하나만 쓴다(단일 진실)**: 이벤트는 tauri-specta `Event` 트레이트로 emit하고(`AutoInputModelProgressPayload`/`AutoInputModelStatePayload`/`AutoInputModelsChangedPayload`), 프론트는 `events.*.listen` + `commands.*`로 소비한다. 이벤트 이름은 타입 이름에서 파생된 `auto-input-model-progress-payload` / `auto-input-model-state-payload` / `auto-input-models-changed-payload` (저장소의 기존 `history-update-payload`와 같은 규칙, 이 스펙트라 버전은 `event_name` 재정의 미지원). 문자열을 양쪽에 손으로 적던 이전 구조는 제거했다 — 이름 불일치가 구조적으로 불가능해진다.
- **수동 경로 보존**: 자동 판별 결과도 span별 `isResolved`/`isOverridden`로 표시되고 클릭(또는 1/2)으로 뒤집힌다. 수동 닫힌 상태에서는 즉시 재판정하지 않는다(사용자 의도 우선).

## 모델·프롬프트 실측 (재현 가능)

하네스: `/tmp/tajagi-auto-models/scripts/prod_bench.py` (앱과 동일 스폰 플래그, b11429 `/completion`, logprobs+n_probs). 158 runs / 78 unit, ko_first·en_first 양방향.

| 결정 형태 | Qwen3-0.6B-Q8_0 | Qwen3-1.7B-Q8_0 |
|---|---|---|
| 단일 A/B 프롬프트 (샘플링) | 50.0% (order flips 78/78) | 58.9% (47/78) |
| 단일 A/B 프롬프트 (logprob) | 50.0% (78/78) | 58.9% (47/78) |
| **후보별 독립 판정 (채택)** | **79.7% (flips 0/78)**, p50 39.7ms / p95 78.8ms | 93.7% (flips 0/78), p50 107ms / p95 184ms |

- **0.6B 유지 근거**: 1.7B는 +14pt 대신 모델 크기·지연·RSS가 3배다. 게다가 결정적 어휘 계층이 대부분을 0ms로 처리하므로 모델은 진짜 모호 케이스만 담당한다.
- **어휘 계층 실측** (`/tmp/tajagi-auto-models/scripts/lexicon_tier.py`, 번들 사전 원본 사용): 79 unit 중 **67개(84.8%) 해결, 해결분 정확도 100.0%(오답 0)**. 미해결 12개 = 진짜 충돌(`내`/`so`, `새`/`to`, `나`/`sk`, `어`/`dj`, `무`/`an`, `해`/`go`), 사전 미등재 활용형(`안녕하세요`, `있어요`), 리터럴 접미(`한글!?12`).
- **탈락 후보**: Jev-Style(라이선스 미해결 + 커스텀 scorer 런타임 필요), 1.7B(위 비용), A/B 프롬프트(편향).

## 변경 파일

- 백엔드: `src-tauri/src/managers/auto_input/{mod,resolver,lexicon,runtime,download,catalog}.rs`, `src-tauri/src/commands/auto_input.rs`, `src-tauri/resources/auto-input/models.json`, `src-tauri/src/{lib.rs,settings.rs}`
- 프론트: `src/composer/{Composer.tsx,Composer.css,autoSpanState.ts,autoSpanState.test.ts}`, `src/components/settings/transform/{AutoInputSettings.tsx,useAutoInputSettings.ts,TransformSettings.tsx}`, `src/i18n/locales/{en,ko}/translation.json`, `src/bindings.ts`(생성물), `src/i18n/resources.ts`(신규), `src/composer/i18n.ts`(수정), `tests/auto-input.spec.ts` + `tests/fixtures/auto-input/`(신규). 타입·커맨드·이벤트는 전부 `@/bindings`에서 가져오고, 수작업 타입 모듈(`src/lib/autoInput.ts`)은 삭제했다. `resolve` 응답 검증(개수·중복·언어)은 `Composer.tsx::validateDecisions`로 이동.

## 검증 (모두 실제 실행)

| 검증 | 명령 | 결과 |
|---|---|---|
| Rust auto_input 유닛 | `cargo test --lib auto_input` | 27 passed |
| Rust 전체 | `cargo test --lib` | 281 passed / 0 failed / 2 ignored |
| clippy | `cargo clippy --all-targets` | auto_input 경고·에러 0 |
| 프론트 유닛 | `bunx vitest run` | 70 passed (4 files) |
| 프론트 빌드/린트 | `bun run build` / `bun run lint` | 성공 / 통과 |
| 라이브 파이프라인 | `TAJAGI_LIVE_RUNTIME=…/llama-server TAJAGI_LIVE_MODEL=…/Qwen3-0.6B-Q8_0.gguf cargo test --lib live_verdict_pipeline -- --ignored --nocapture` | 1 passed (4.18s): 어휘 계층 `[None, En, Ko, En, None]`, 모델 계층 둘 다 Ko → 최종 문장 `안녕하세요 meeting 오늘 React 있어요` |
| 런타임 자산 핀 | macOS arm64 아카이브 다운로드 + sha256 + 추출 + `--version` | sha256 `740288ec…` 일치, `llama-b11429/llama-server` 실행 → `version: 0.6.0-dev (build 11429, commit d81235049)` |
| 모델 자산 핀 | HF API + ranged GET | `lfs.sha256 9465e63a…` = 카탈로그, size 639,446,688, `x-linked-etag` 일치, magic `GGUF` |
| 앱 스모크(기동) | `bun run tauri dev` | **기동 크래시 1건 발견·수정**(아래) |
| 프론트 컴포넌트 E2E(설정 패널·컴포저) | `bun run test:playwright`(신규 `tests/auto-input.spec.ts`: 실제 컴포넌트 + Tauri IPC mock) | 6 passed (기존 2 + 신규 4). 다운로드→진행률 이벤트→취소→로드→언로드→삭제, 활성 토글, 오류 Alert, 컴포저 타이핑→단어별 판정→span 뒤집기 고정, 저장된 앱 언어 반영 |
| 컴포저 i18n 상태 프로브 | 실 브라우저에서 `i18n.options.resources` 판독 | 수정 전 `resourceLangs: []`(모든 라벨이 raw 키) → 수정 후 `[en, ko]`, `t("composer.spansAria")` 정상 |

- **발견·수정한 기동 크래시**: `init_on_startup`이 Tauri setup(비-reactor 스레드)에서 `tokio::spawn`을 호출해

  ```
  there is no reactor running, must be called from the context of a Tokio 1.x runtime
  ```

  로 abort했다. `tauri::async_runtime::spawn`으로 교체(저장소 관례와 동일). 유닛 테스트로는 잡히지 않는 경로 — GUI 스모크에서만 드러난다.

## 리뷰 결과 (2026-10-13)

- 서브에이전트 독립 리뷰는 이 환경에서 실행 불가(모델 미설정, `No model selected`) → 셀프 리뷰로 대체했다. **독립 검증 아님**을 명시한다.
- 검토 범위: `resolver`(프롬프트·확률 파싱·예산 트리밍), `lexicon`, `runtime`(스폰 인자·readiness·자식 수명), `download`(진행률·취소·sha256), `mod`(2계층 오케스트레이션·이벤트 발행), `autoSpanState`(auto/manual 전이·stale 응답 방지), `Composer` 자동 모드 효과(수동 경로 회귀 없음 확인).
- 발견·수정 2건:
  1. **기동 크래시**: `init_on_startup`이 비-reactor 스레드에서 `tokio::spawn` → abort. `tauri::async_runtime::spawn`으로 교체.
  2. **IPC 중복·이벤트 이름 불일치**: 생성된 `bindings.ts`와 수작업 문자열 emit이 어긋나 있었다(생성 맵은 `…-payload`, 발행은 `…`). typed `Event` emit + `commands.*`/`events.*` 소비로 통일하고 수작업 타입 모듈을 삭제.
- 발견·수정 3·4건(컴포저 i18n, 아래 "부수 발견" 참조).
- 남은 표면은 실제 Tauri 프로세스의 GUI 조작(NSPanel 창에 대한 물리 키·마우스, 실 HF 다운로드 클릭 경로)뿐이다(아래).

## 부수 발견·수정: 컴포저 창 i18n

자동입력 UI 문자열이 컴포저 창에 있다는 이유로 확인하다가, **컴포저 창이 모든 라벨을 raw i18n 키로 렌더**하는 것을 실측으로 잡았다(`aria-label="composer.spansAria"`, `composer.keysHintAuto` 등, t+5s에도 동일).

- **원인 1(핵심)**: `src/composer/i18n.ts`가 자체 구현한 `import.meta.glob("../i18n/locales/*/translation.json")`의 키 정규식이 `/^\.\/\.\.\/i18n\/locales\//`를 요구했지만 Vite가 넘기는 키는 `../i18n/locales/...` → **매칭 0건 → 리소스가 빈 상태**(`i18n.options.resources === []`). 컴포저는 앱과 별개 엔트리라 자체 i18next 인스턴스를 쓰므로 대체 경로가 없었다. (`src/i18n/index.ts`는 `./locales/...` 패턴이라 정상 동작 — 그래서 설정 창은 멀쩡했다.)
- **원인 2**: 같은 파일의 앱 언어 동기화가 raw `invoke("get_app_settings")`를 `{status, data}` 봉투로 검사했지만, raw invoke는 커맨드의 Ok 값(AppSettings)을 그대로 준다 → 분기가 절대 성립하지 않아 **저장된 앱 언어가 컴포저에 반영되지 않았다**(OS 로케일만 사용).
- **수정**: 로케일 리소스 로딩을 `src/i18n/resources.ts` 하나로 모아(단일 glob + ko/en allowlist) 설정 창·컴포저·(이미 공유하던) 오버레이가 같은 번들/같은 언어 집합을 쓰게 했고, 컴포저는 `settings.app_language`를 직접 읽는다. 리소스가 번들되어 있으므로 `initAsync: false`로 동기 초기화. 검증: 신규 spec "renders translations and follows the saved app language"(한국어 라벨 확인) + 프로브에서 리소스 적재 확인.

## 남은 검증 (GUI)

재현: `CARGO_TARGET_DIR=<공유 타깃> CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev` (식별자를 임시로 바꾸면 실제 사용자 데이터와 격리해 첫 실행 상태를 재현할 수 있다 — `src-tauri/tauri.conf.json`의 `identifier`를 `com.hee10k.tajagi.smokeauto`로 바꾸고 스모크 후 원복. 접근성/스크린 권한은 같은 바이너리 경로를 재사용하므로 승인 상태가 유지된다.)

- 기동 스모크 시점에 화면이 잠겨 있었다(`CGSSessionScreenIsLocked=Yes`, SecureInput held by loginwindow) → 접근성 트리 판독·스크린샷이 불가해 **설정 패널 조작과 컴포저 타이핑 판정은 미검증**. 화면 잠금 해제 후 아래를 실측한다.
  1. 설정 → 자동입력: 카탈로그 선택, 다운로드(진행률·취소), 로드/언로드, 삭제, 실패 시 `Alert`.
  2. 컴포저 실제 키 입력: `dkssudgktpdy`→안녕하세요(Ko), `meeting`(En 유지), span 클릭/1·2 뒤집기, Esc/Backspace, Cmd/Ctrl+Enter 커밋 붙여넣기.
  3. 앱 종료 시 `llama-server` 자식 프로세스 미잔존.
- `bun run test:playwright` (`.github/workflows/playwright.yml`) 미실행.
- `bun run check:translations`는 이 변경 전에도 실패 상태다(비-ko 로케일 97키 누락 = 기존 77 + 이번 20). 이 포크는 UI 언어를 ko/en만 노출하므로 기존 77키 백필과 함께 별도로 처리한다.

## 후속(의도된 방향, 미적용)

- **모델을 자동 모드의 필수 조건에서 제거**: 어휘 계층이 85%를 모델 없이 처리하므로, 모델 미설치 상태에서도 자동 모드가 동작하고 모호 span만 "사전으로 결정할 수 없음"으로 표면화하는 편이 낫다. 현재는 `Composer.tsx`의 `isAutoMode = enabled && loaded_model` 게이트와 `AutoInputSettings` 문구를 함께 바꿔야 하므로 별도 작업으로 분리했다.