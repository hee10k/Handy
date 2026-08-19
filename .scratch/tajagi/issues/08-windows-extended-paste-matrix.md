# 08 — Windows 확장 paste 매트릭스 (선택, MVP.1 가능)

**What to build:** POC(02)에서 검증한 4개 앱 외에 일상 사용 빈도가 높은 Windows 앱들에서도 커밋(paste)이 안정적으로 동작하는 paste 매트릭스를 확장·문서화한다.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Office(Word/Outlook), Teams, 메모장 계열, 이메일/브라우저 입력 폼 등 주요 후보 앱에서 반복 테스트
- [ ] PasteMethod 매트릭스(paste_tx)에 앱별 특이사항 반영·문서화
- [ ] 실패 사례가 있으면 03 이후 경로로 회귀 테스트 대상 분류 및 티켓 재발행
- [ ] 결과를 CONTEXT.md/위키 문서로 남긴다