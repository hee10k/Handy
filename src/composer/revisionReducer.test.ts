import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  currentText,
  EMPTY_REVISION,
  originalText,
  revisionReducer,
  type RevisionState,
} from "./revisionReducer";

// 헬퍼: 시나리오를 순서대로 실행해 상태를 만들어주는 테스트 전용 구문.
function run(
  initialState: RevisionState,
  actions: Parameters<typeof revisionReducer>[1][],
): RevisionState {
  return actions.reduce(revisionReducer, initialState);
}

describe("revisionReducer", () => {
  it("빈 세션에서 최초 입력이 v0 으로 확정된다", () => {
    const state = revisionReducer(EMPTY_REVISION, {
      type: "replace-current",
      text: "안녕하세요",
    });
    expect(state.revisions).toEqual(["안녕하세요"]);
    expect(state.index).toBe(0);
    expect(originalText(state)).toBe("안녕하세요");
    expect(currentText(state)).toBe("안녕하세요");
  });

  it("변환 완료마다 새 리비전이 추가되고 포인터가 끝으로 간다 (v0 → v1 → v2)", () => {
    const state = run(EMPTY_REVISION, [
      { type: "replace-current", text: "hello world" },
      { type: "append", text: "Hello, world." },
      { type: "append", text: "반갑습니다." },
    ]);
    expect(state.revisions).toEqual(["hello world", "Hello, world.", "반갑습니다."]);
    expect(state.index).toBe(2);
    expect(originalText(state)).toBe("hello world"); // v0 보존
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);
  });

  it("undo 는 한 단계 이전으로, redo 는 다시 앞으로 이동한다", () => {
    const history = run(EMPTY_REVISION, [
      { type: "replace-current", text: "v0" },
      { type: "append", text: "v1" },
      { type: "append", text: "v2" },
    ]);
    const undone = revisionReducer(history, { type: "undo" });
    expect(currentText(undone)).toBe("v1");
    expect(undone.index).toBe(1);
    const redone = revisionReducer(undone, { type: "redo" });
    expect(currentText(redone)).toBe("v2");
    expect(redone.index).toBe(2);
  });

  it("undo 는 경계(맨 앞)에서 무효, redo 는 경계(맨 끝)에서 무효다", () => {
    const only = run(EMPTY_REVISION, [{ type: "replace-current", text: "v0" }]);
    expect(canUndo(only)).toBe(false);
    expect(revisionReducer(only, { type: "undo" })).toBe(only); // 그대로
    expect(canRedo(only)).toBe(false);
    expect(revisionReducer(only, { type: "redo" })).toBe(only);
  });

  it("이동 후 다시 편집하면 현재 리비전이 교체되고 redo 꼬리가 버려진다 (분기 규칙)", () => {
    const history = run(EMPTY_REVISION, [
      { type: "replace-current", text: "original" },
      { type: "append", text: "first" },
      { type: "append", text: "second" },
    ]);
    // v2 까지 간 뒤 v0 로 되감기.
    const rewound = run(history, [
      { type: "undo" },
      { type: "undo" },
    ]);
    expect(currentText(rewound)).toBe("original");

    // 되감은 v0 에서 편집 → 새 분기: 뒤 리비전(first, second) 사라짐.
    const branched = revisionReducer(rewound, {
      type: "replace-current",
      text: "original 편집됨",
    });
    expect(branched.revisions).toEqual(["original 편집됨"]);
    expect(branched.index).toBe(0);
    expect(canRedo(branched)).toBe(false); // redo 꼬리 없음 → 재시작 분기
  });

  it("중간 리비전에서 편집하면 해당 위치 이후 redo 꼬리만 버린다", () => {
    const history = run(EMPTY_REVISION, [
      { type: "replace-current", text: "v0" },
      { type: "append", text: "v1" },
      { type: "append", text: "v2" },
    ]);
    // v2 → v1 로 되감기 후 편집.
    const rewound = revisionReducer(history, { type: "undo" });
    const branched = revisionReducer(rewound, {
      type: "replace-current",
      text: "v1 수정",
    });
    expect(branched.revisions).toEqual(["v0", "v1 수정"]);
    expect(branched.index).toBe(1);
  });

  it("되감은 뒤 변환 완료(append)도 redo 꼬리를 버리고 새 리비전을 붙인다", () => {
    const history = run(EMPTY_REVISION, [
      { type: "replace-current", text: "v0" },
      { type: "append", text: "v1" },
      { type: "append", text: "v2" },
    ]);
    // v2 → v1 로 되감은 뒤 변환 → redo(v2) 제거, v1next 추가.
    const rewound = revisionReducer(history, { type: "undo" });
    const next = revisionReducer(rewound, { type: "append", text: "v1next" });
    expect(next.revisions).toEqual(["v0", "v1", "v1next"]);
    expect(next.index).toBe(2);
  });

  it("reset 은 세션을 비운다 (컴포저 재오픈)", () => {
    const history = run(EMPTY_REVISION, [
      { type: "replace-current", text: "v0" },
      { type: "append", text: "v1" },
    ]);
    const reset = revisionReducer(history, { type: "reset" });
    expect(reset).toEqual(EMPTY_REVISION);
    expect(originalText(reset)).toBe("");
    expect(currentText(reset)).toBe("");
  });

  it("원문(v0)과 현재 리비전을 가져온다", () => {
    const state = run(EMPTY_REVISION, [
      { type: "replace-current", text: "v0" },
      { type: "append", text: "v1" },
      { type: "append", text: "v2" },
    ]);
    const back = revisionReducer(state, { type: "undo" }); // 현재 = v1
    expect(originalText(back)).toBe("v0");
    expect(currentText(back)).toBe("v1");
  });
});