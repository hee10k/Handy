// Revision 저장소 (ticket 05) — 순수 리듀서.
//
// 컴포저 세션의 리비전 이력을 메모리 리스트로 관리한다:
//   - revisions[0] = v0 (원문: 최초 입력 텍스트)
//   - 각 변환 완료가 vn 을 append 한다 (v0 → v1 → … → vn)
//   - undo / redo 는 index 포인터만 이동한다.
//
// 이력 무결 규칙 (ticket 05, "이동 후 다시 편집해도 상태 무결"):
//   * 되감기(undo) 후 편집 → 현재 리비전을 새 텍스트로 교체하고, 그 뒤(redo
//     꼬리) 리비전을 버린다. 새 분기(new-branch)를 시작한다.
//   * 변환 완료(append) 도 동일하게 현재 위치 이후를 버리고 새 리비전을 추가한다.
//
// 리듀서는 순수 함수라 단위 테스트 하기 쉽다: 같은 (state, action) → 같은 결과.

export interface RevisionState {
  /** 리비전 스냅샷 리스트; revisions[0] 은 세션 원문 v0 */
  revisions: string[];
  /** 현재 리비전 포인터 (revisions 배열 인덱스). 빈 세션이면 0. */
  index: number;
}

export type RevisionAction =
  | { type: "reset" } // 새 세션 (컴포저 열림) — 이력 초기화
  | { type: "replace-current"; text: string } // 사용자 편집: 현재 리비전 교체 + redo 꼬리 제거
  | { type: "append"; text: string } // 변환 완료: 현재 위치 이후 버리고 새 리비전 추가
  | { type: "undo" } // 한 단계 이전 리비전으로
  | { type: "redo" }; // 한 단계 다음 리비전으로

/** 빈 세션 초기 상태 */
export const EMPTY_REVISION: RevisionState = { revisions: [], index: 0 };

/** 현재 리비전 텍스트 (빈 세션이면 "") */
export function currentText(state: RevisionState): string {
  if (state.revisions.length === 0) return "";
  return state.revisions[state.index];
}

/** 세션 원문 v0 (빈 세션이면 "") */
export function originalText(state: RevisionState): string {
  if (state.revisions.length === 0) return "";
  return state.revisions[0];
}

export function canUndo(state: RevisionState): boolean {
  return state.index > 0;
}

export function canRedo(state: RevisionState): boolean {
  return state.index < state.revisions.length - 1;
}

export function revisionReducer(
  state: RevisionState,
  action: RevisionAction,
): RevisionState {
  switch (action.type) {
    case "reset":
      return EMPTY_REVISION;

    case "replace-current": {
      const text = action.text;
      // 아직 v0 가 없으면 최초 입력을 v0 로 확정한다.
      if (state.revisions.length === 0) {
        return { revisions: [text], index: 0 };
      }
      // 현재 리비전을 새 텍스트로 교체하고 그 뒤를 버린다 (dividing rule).
      const revisions = state.revisions.slice(0, state.index);
      revisions.push(text);
      return { revisions, index: state.index };
    }

    case "append": {
      // 되감아 있으면 redo 꼬리를 버리고, 현재 위치 다음에 새 리비전을 붙인다.
      const revisions = state.revisions.slice(0, state.index + 1);
      revisions.push(action.text);
      return { revisions, index: revisions.length - 1 };
    }

    case "undo":
      if (state.index <= 0) return state;
      return { revisions: state.revisions, index: state.index - 1 };

    case "redo":
      if (state.index >= state.revisions.length - 1) return state;
      return { revisions: state.revisions, index: state.index + 1 };

    default:
      // 리듀서가 아는 모든 action 을 처리했으므로 도달할 수 없다. 전체 타입
      // 체크(noFallthroughCasesInSwitch) 하에 default 가 남는 건 방어용이다.
      return state;
  }
}