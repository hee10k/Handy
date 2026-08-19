# 07 — macOS 지원

**What to build:** 컴포저가 macOS에서 키 입력 가능한 창으로 동작하고(NSPanel key window 설정), 접근성 권한 안내가 있으며, macOS 앱에서의 paste 매트릭스(기존 macos paste 경로 재사용)를 검증한다.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] 컴포저가 macOS에서 포커스/한글 IME 입력 가능 (NSPanel `can_become_key_window` 또는 이에 상응하는 구성)
- [ ] 핫키·키 주입을 위한 접근성 권한 요청/안내 플로우 재사용 확인
- [ ] macOS paste 검증: 기본 셋(Chrome, VS Code, 메일, 메모, 터미널) 각 5회 반복
- [ ] SecureInput 활성 상태에서도 커밋/캔슬이 안전하게 처리된다 (기존 secure_input 경로 계승)
- [ ] 오디오(기본 OFF) 포함 기존 macOS 기능 회귀 없음