# 타자기 (Tajagi) — 프로젝트 컨텍스트

타자기는 Handy(hee10k/handy, MIT)를 기반으로 하는 **AI 타자기**입니다.
핫키로 컴포저를 띄워 타이핑(한글 IME)하고, AI로 변환해 원래 앱의 커서 위치에 붙여넣습니다.
음성 입력은 선택적 입력 소스로 유지됩니다 (기본 OFF).

이 문서는 에이전트/협업자가 사용하는 용어 사전 + 결정 기록입니다. 사양은 `.scratch/tajagi/SPEC.md`, 티켓은 `.scratch/tajagi/issues/`를 우선으로 하세요.

## 도메인 용어

| 용어 | 의미 |
|---|---|
| **컴포저 (Composer)** | 핫키로 표시되는 항상-위 편집 창 (textarea). 키보드 입력 소스의 사용자 인터페이스 |
| **transform** | AI 변환 동작. 코드상 기존 `post_process` 엔진(설정·클라이언트·프롬프트 라이브러리)을 그대로 계승하며 제품 용어만 transform으로 통일 |
| **커밋 (Commit)** | 최종 텍스트를 이전 포커스 앱의 커서 위치에 붙여넣고 클립보드를 복원하는 동작 |
| **입력 소스** | 키보드(컴포저) 또는 음성(기존 오디오 파이프라인). 음성은 기본 비활성 |
| **리비전 (Revision)** | 컴포저 세션 내 원문→변환 결과 이력 (v0..vn), undo/redo 포함 |
| **로컬 히스토리** | 기존 `HistoryEntry` 저장소를 두 입력 경로에 공용으로 사용 |
| **POC 게이트** | "한글 조합 → AI 수정 → 원래 커서 위치 paste"가 Chrome/VS Code/Notepad/Terminal에서 반복 안정적으로 동작 — MVP 배송 기준 |
| **post_process** | 폐기되는 용어 아님 — 코드 스키마/설정 키는 유지하고 표시 이름만 transform으로. 마이그레이션은 티켓별로 |

## 경계 조건 (boundary conditions)

- **소프트 포크**: upstream cjpais/Handy merge를 계속 수용. 구조 divergence를 만들지 않는다.
- **음성 유지**: 오디오 파이프라인·모델 관리·VAD·Whisper/Parakeet은 제거하지 않는다. 첫 실행 기본 OFF — 설정에서 활성화.
- **라이선스**: MIT 유지. VibePrompter(GPL-3.0)는 UX 벤치마크만 — 코드는 clean-room.
- **최소 변경**: 신규 기능은 기존 자산(post_process, paste 경로, 설정, 트레이, 단축키, 히스토리)의 재사용/래핑 우선.

## 결정 기록 (ADR 요약, 2026-08-20)

| # | 결정 | 근거 | 상태 |
|---|---|---|---|
| 1 | 제품명 **타자기 (Tajagi)**, repo URL은 hee10k/handy 유지 | "VibePrompter"는 GPL 앱과 브랜드 충돌. repo는 이동 비용이 큼 | accepted |
| 2 | 소프트 포크 복귀 (upstream merge 유지) | 음성 유지로 구조 divergence가 사라짐 — merge 충돌 비용 감소 | accepted |
| 3 | 음성 입력 유지, **기본 OFF** (설정에서 ON) | 신규 사용자 온보딩 단순화, 타자기 브랜딩 유지, 자산 보존 | accepted |
| 4 | Transform = 기존 post_process 스택 재사용 (+ API 키를 OS keyring으로 이전) | provider/키/모델/프롬프트 라이브러리/UI가 이미 완성 | accepted |
| 5 | Commit = 기존 paste 경로(clipboard 저장→키 주입→복원 + paste_tx 매트릭스) 래핑만 | 새로 짜면 OS 통합 회귀 | accepted |
| 6 | POC 게이트 정의 (위 표) | MVP 전환 기준 확정 | accepted |
| 7 | 티켓 트래커 = 로컬 `.scratch/tajagi/issues/` | 설정 비용 0 | accepted |
| 8 | i18n: 셸·기존 로케일 유지, 신규 키는 ko/en만 | 번역 전량 부담 회피 | accepted |
| 9 | dev loop: Mac 개발 + Orca 원격(paired-runtime)으로 Windows 실기기 테스트 | Windows paste 매트릭스는 실기기 검증 필요 | accepted |
| 10 | 코어 상호작용 = 타이핑 컴포저 (선택-텍스트 rewrite 아님) | POC 게이트와 일치. rewrite는 로드맵에 없음 | accepted |

## 작업 규칙

- 커밋: conventional commit (`feat:`/`fix:`/`refactor:`/`chore:`), why 중심.
- 티켓은 블로커 순서로 처리: `01 → 02/03 → 04 → …`.
- Windows 실기기 검증이 필요한 티켓은 Orca 원격(terminal + computer-use) 사용.