# 타자기 (Tajagi) — 사양

출처: 그릴링 세션(2026-08-20) + hand repo 조사. 어휘는 `CONTEXT.md`를 따름.

## Problem Statement

AI 채팅·문서·메일에 쓸 텍스트를 만들 때, 사용자는 어디에 붙여넣기 전에 한국어/영문으로 다듬고 변환하고 싶다. 현재는 별도 에디터나 웹 UI를 오가며 복사·붙여넣기를 반복해야 하고, 최종 앱의 IME 경험이 어색한 경우가 많다. 사용자가 타이핑한 곳(앱 전환, IME 조합, AI 변환)을 떠나지 않고 입력 → AI 변환 → 즉시 붙여넣기까지 한 흐름으로 처리하는 도구가 필요하다.

## Solution

타자기는 글로벌 핫키로 **컴포저**(항상 위 textarea 창)를 띄운다. 사용자는 한글/영문을 타이핑하고, 변환 모드(Polish / Translate English / Prompt English / Custom)를 선택하면 AI가 스트리밍으로 결과를 채우고, 편집 후 **커밋**하면 원래 앱(핫키를 누른 시점의 포커스)과 커서 위치로 자동 붙여넣기된다. 클립보드는 복원되고 포커스는 원래 앱으로 돌아온다. 음성 입력은 동일 transform 엔진을 쓰는 선택적 입력 소스로 유지된다(기본 OFF).

## User Stories

1. As a 사용자, I want 핫키로 컴포저를 띄울 수 있다, so that 앱 전환 없이 작성을 시작할 수 있다.
2. As a 사용자, I want 컴포저가 항상 위에 표시된다, so that 기존 앱이 가려지지 않고 컨텍스트를 유지할 수 있다.
3. As a 사용자, I want 컴포저에서 한글 IME 조합 입력이 기존 OS 동작 그대로 동작한다, so that 조합 중인 문자도 자연스럽게(자소 분리 없이) 표시된다.
4. As a 사용자, I want 입력한 텍스트를 그대로 커밋할 수 있다, so that 변환 없이 단순 입력기로도 쓸 수 있다.
5. As a 사용자, I want Polish 변환이 입력 언어를 유지한 채 문법·표현만 다듬는다, so that 한글 입력이 한글로 향상된다.
6. As a 사용자, I want Translate English 변환으로 한국어 텍스트를 영어로 옮긴다, so that 해외 앱에 바로 붙여넣을 수 있다.
7. As a 사용자, I want Prompt English 변환으로 메모 수준 입력을 잘 짜인 영문 프롬프트로 바꾼다, so that AI 채팅 앱에 품질 좋은 프롬프트를 넣는다.
8. As a 사용자, I want Custom instruction 모드로 자신만의 지시를 저장·선택할 수 있다, so that 반복 작업(요약, 톤 변경 등)을 자동화한다.
9. As a 사용자, I want 변환 결과가 streaming으로 표시된다, so that 긴 응답도 진행을 볼 수 있고 취소 판단이 빠르다.
10. As a 사용자, I want streaming 중에도 취소(Esc)할 수 있다, so that 잘못된 방향의 변환 비용을 줄인다.
11. As a 사용자, I want 변환 결과를 커밋 전에 직접 편집할 수 있다, so that AI 실수를 수정한 뒤 붙여넣는다.
12. As a 사용자, I want Enter(또는 구성된 커밋 단축키)로 커밋하면 원래 앱 포커스가 복귀되고 커서 위치에 텍스트가 붙여넣어진다, so that 붙여넣기를 위해 다시 클릭할 필요가 없다.
13. As a 사용자, I want Esc로 컴포저를 폐기하면 원래 앱에 아무 변화가 없다, so that 취소가 안전하다.
14. As a 사용자, I want 커밋 후 기존 클립보드 내용이 복원된다, so that 붙여넣기 과정이 클립보드를 훼손하지 않는다.
15. As a 사용자, I want 원문(v0)부터 각 변환 결과(v1..vn)가 리비전으로 쌓인다, so that 실수 시 이전 상태로 되돌릴 수 있다.
16. As a 사용자, I want undo/redo로 리비전을 오갈 수 있다, so that 여러 변환 실험을 안전하게 비교한다.
17. As a 사용자, I want 원문↔현재 결과 diff를 볼 수 있다, so that AI가 무엇을 바꿨는지 검토한다.
18. As a 사용자, I want 최근 변환 내역이 로컬에 남는다, so that 비슷한 텍스트를 다시 만들 때 참고·재사용한다.
19. As a 사용자, I want 설정에서 입력 소스(음성)를 켜고 끌 수 있다, so that 필요할 때만 오디오 파이프라인을 활성화한다.
20. As a 사용자(first-run), I want 기본 상태에서 모델 다운로드·마이크 권한 없이 컴포저를 쓴다, so that 최초 실행이 즉시 가치를 준다.
21. As a 사용자, I want 핫키를 설정에서 변경할 수 있다, so that 다른 앱과 충돌을 피한다.
22. As a 사용자, I want provider(OpenAI 호환·Anthropic 등)와 base URL·모델을 설정할 수 있다, so that 선호 모델을 쓴다.
23. As a 사용자, I want 로컬 LLM(Ollama 등 OpenAI 호환 엔드포인트)을 쓸 수 있다, so that 인터넷 없이도 동작한다.
24. As a 사용자, I want API 키가 OS keyring에 저장된다, so that 설정 파일에 평문으로 남지 않는다.
25. As a 사용자, I want 모델 목록을 provider에서 조회해 선택할 수 있다, so that 모델명을 외울 필요가 없다.
26. As a 사용자, I want 변환 실패 시 컴포저가 그대로 열려 있고 입력이 보존된다, so that 텍스트가 유실되지 않는다.
27. As a 사용자, I want 트레이에서 앱을 종료/설정/단축키 안내를 쓸 수 있다, so that 배후 실행 UX가 일관된다.
28. As a 사용자, I want 앱 자동 시작 옵션을 쓸 수 있다, so that 부팅 후 바로 핫키를 쓴다.
29. As a 사용자(macOS), I want 컴포저가 키 입력 가능한 창으로 뜨고 접근성 권한 안내가 있다, so that 핫키·키 주입이 안내와 함께 동작한다.
30. As a 사용자(Windows), I want Chrome/VS Code/Notepad/Terminal 등 주요 앱에서 paste 매트릭스가 안정적이다, so that 일상 앱에서 믿고 쓴다.
31. As a 사용자(음성), I want 기존 음성→변환→붙여넣기 흐름이 그대로 동작한다, so that 타이핑이 어려운 상황에서도 입력한다.
32. As a 사용자, I want UI 문구가 ko/en로 전환된다, so that 한국어 및 영어 사용자가 각자 언어로 쓴다.
33. As a 사용자, I want 컴포저 창 위치·크기가 화면에 맞게 표시된다, so that 어디서 열어도 편집이 편하다.
34. As a 사용자, I want 커밋 시 빈 텍스트는 붙여넣지 않는다, so that 실수로 빈 커밋이 안 들어간다.
35. As a 사용자, I want 자주 쓰는 변환을 원클릭 퀵버튼으로 실행할 수 있다, so that 모드 선택 단계를 건너뛴다.
36. As a 사용자, I want Cmd/Ctrl+1..0 퀵단축키로 각 퀵버튼을 키보드로 실행한다, so that 마우스 없이 빠르게 변환한다.
37. As a 사용자, I want 퀵버튼 우선순위가 지금 쓰는 앱 종류(브라우저/에디터/메일/기타)에 따라 달라진다, so that 맥락에 맞는 동작이 먼저 눈에 띈다.
38. As a 사용자, I want 퀵 슬롯(Cmd+5..0)을 설정에서 원하는 변환으로 채울 수 있다, so that 내 자주 쓰는 조합을 고정한다.

## Implementation Decisions

- **입력 소스 2개 + 공용 transform**: 키보드(컴포저)와 음성(기존 파이프라인)이 같은 transform 엔진을 공유. 오디오 코드는 수정하지 않고 기본 비활성 설정만 추가.
- **S1 Transform 시임**: `TransformProvider` 트레이트(`transform(text, instruction)`)가 기존 OpenAI 호환 chat 클라이언트와 `post_process_*` 설정(provider/base_url/키/모델/프롬프트 라이브러리) 위에 얹힘. streaming은 delta 이벤트로 노출. API 키는 OS keyring으로 이전(설정 저장소의 SecretMap에서 마이그레이션 경로 1회).
- **S2 Commit 시임**: 얇은 `CommitEngine`이 기존 paste 경로(클립보드 저장→키 주입→지연→복원, paste_tx per-app 매트릭스, 포커스 복귀)를 호출. 새 OS 코드 없음.
- **S3 Composer 시임**: 기존 오버레이의 핫키→창 표시 경로를 유지하되, 창을 키 입력 가능한 textarea 창으로 교체. macOS는 NSPanel key window 설정(`can_become_key_window`) 필요. 프론트-백엔드는 tauri command + 이벤트(specta 타입 바인딩) 유지.
- **리비전 모델**: 세션 내 메모리 리스트 `[v0(원문) … vn]` + undo/redo 포인터. diff는 원문↔현재. 영속화 없음(로컬 히스토리는 기존 HistoryEntry가 담당).
- **설정**: `post_process_*` 스키마는 유지(표시명을 transform으로), 추가 설정: `voice_input_enabled`(기본 false), 컴포저 핫키(기존 ShortcutBinding 인프라), transform 모드 정의(Polish/Translate/Prompt English/Custom + 커스텀 인스트럭션 목록).
- **오류 처리**: 변환 실패·캔슬 시 컴포저 유지, 입력 보존, 부분 붙여넣기 금지, 클립보드 비훼손.
- **히스토리**: 기존 전사 히스토리 저장소를 컴포저 결과에도 재사용(변경 최소).
- **i18n**: 셸·기존 로케일 유지. 신규 키는 ko/en만 번역.
- **퀵 액션(09)**: 설정 슬롯 10개 `quick_action_slots`(기본 4 = 기본 모드, 5~10 빈). 컴포저는 슬롯 순서로 퀵버튼 렌더 + Cmd/Ctrl+1..N 바인딩(포커스 중, IME 조합 억제). macOS AX로 전경 앱 카테고리(브라우저/에디터/메일/기타) 감지 → MVP는 우선순위/강조만 변경, 실패 시 고정 기본 폴백.

## Testing Decisions

- **E2E(POC 게이트)는 자동화하지 않음** — OS 통합(글로벌 핫키, IME, 포커스, paste)은 수동 검증 + Windows 실기기는 Orca 원격(terminal + computer-use) 사용.
- 좋은 테스트: 외부 동작만 검증. llm_client.rs의 기존 mock-HTTP(tokio + 로컬 TCP 리스너 `serve_one_response`) 패턴을 이어받아 프로토콜 파싱/오류 경로 테스트.
- 단위 테스트 대상: 변환 프롬프트 구성(모드별 지시문), 리비전 리듀서(원문→리비전 추가/undo/redo/diff 선택), keyring 추상화 저장·조회·실패, streaming 이벤트 시퀀스.
- paste 자체에는 테스트 하네스를 만들지 않고 앱별 매트릭스를 문서화.

## Out of Scope

- 컨텍스트 인식 추천·문구 라이브러리·퀵 입력 (별도 트랙, 이후 예정)
- Linux X11 / Wayland 실험 지원
- cost/latency/token 추적 (로컬 히스토리 범위까지만)
- 오디오 파이프라인 개편 (기본 OFF 플래그만 추가)
- 히스토리 UI 개편 (기존 재사용·최소 수정)
- 선택-텍스트 rewrite 상호작용

## Further Notes

- hee10k/handy는 소프트 포크 유지 — upstream merge 주기적으로 수용, PR 전 conflict 확인.
- 패키지/앱 id 예: `com.hee10k.tajagi` (01 티켓에서 확정).
- Windows 실기기 검증은 Orca paired-runtime 원격 사용. repo clone 셋업은 01 티켓 범위에 포함 가능.
- VibePrompter(GPL)는 UX 벤치마크만 — 구현은 독립.