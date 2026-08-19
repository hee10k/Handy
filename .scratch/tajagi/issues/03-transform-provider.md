# 03 — TransformProvider (백엔드)

**What to build:** 컴포저 텍스트를 구성된 provider로 변환하는 백엔드 경로. 기존 post_process 스택(OpenAI 호환 chat 클라이언트, provider/base_url/모델/프롬프트 설정, 모델 목록 조회)을 재사용하고, API 키는 OS keyring으로 이전한다. 결과는 streaming delta 이벤트로 내보낸다. 커맨드/이벤트 레벨에서 검증 가능 — UI는 04.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `transform(text, instruction)` 호출 → 설정된 provider(OpenAI 호환·Anthropic·로컬 Ollama)로 요청 → streaming delta 이벤트로 결과 수신
- [ ] 변환 모드 4종의 프롬프트 구성이 존재한다 (Polish=입력 언어 유지, Translate English, Prompt English, Custom+사용자 지시)
- [ ] API 키가 OS keyring에 저장·조회·삭제된다 (기존 설정 저장소 값에서 1회 마이그레이션; 남은 평문 값 제거)
- [ ] 요청 오류(401/429/네트워크/파싱)가 사용자 메시지로 구분되어 반환되고 비밀값이 누출되지 않는다 (기존 mock-HTTP 테스트 패턴 계승)
- [ ] 모델 목록 조회(`fetch_models`) 재사용 확인
- [ ] 단위 테스트: 프롬프트 구성, streaming 시퀀스, keyring 추상화, 오류 파싱