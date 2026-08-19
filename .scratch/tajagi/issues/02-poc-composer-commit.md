# 02 — POC: 컴포저 + 커밋 루프

**What to build:** 글로벌 핫키를 누르면 **컴포저**(항상 위 textarea 창)가 뜨고, 사용자는 한글/영문을 타이핑(OS IME)한다. 커밋(Enter 또는 전용 단축키)하면 핫키 직전 포커스 앱으로 복귀해 커서 위치에 textarea 내용이 붙여넣어지고, 클립보드는 복원된다. Esc는 아무 변화 없이 폐기한다. **이 티켓이 POC 게이트다**: "한글 조합 → AI 수정(여기선 입력 그대로 커밋) → 원래 커서 위치 paste"가 Chrome/VS Code/Notepad/Terminal에서 반복 안정적으로 동작하는지 검증한다. AI transform은 다음 티켓.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 핫키(기본값 확정: Windows `ctrl+alt+space` 등 미충돌 조합) → 컴포저 표시, 포커스 가용, 항상 위 유지
- [ ] textarea에서 한글 IME 조합이 자소 분리 없이 입력된다 (조합 중 상태 표시 포함)
- [ ] 커밋 → 이전 포커스 앱 복귀 + 커서 위치 paste + 클립보드 원상복원
- [ ] Esc → 컴포저 닫힘, 원래 앱에 변화 없음, 클립보드 무변화
- [ ] 빈 텍스트 커밋은 무시된다
- [ ] POC 게이트: Chrome / VS Code / Notepad / Terminal 각 5회 연속 반복 성공 (Windows 실기기, Orca 원격으로 문서화된 검증)
- [ ] macOS에서도 동일 루프 동작 (컴포저 창 키 입력 가능)
- [ ] 오디오 파이프라인 회귀 없음 (동작만 확인)