import { describe, expect, it } from "vitest";
import { diffTexts } from "./textDiff";

describe("diffTexts", () => {
  it("같은 텍스트는 same 세그먼트 하나", () => {
    expect(diffTexts("안녕 세상", "안녕 세상")).toEqual([
      { type: "same", text: "안녕 세상" },
    ]);
  });

  it("원문이 비면 모두 추가", () => {
    expect(diffTexts("", "새 내용")).toEqual([{ type: "add", text: "새 내용" }]);
  });

  it("결과가 비면 모두 삭제", () => {
    expect(diffTexts("기존 내용", "")).toEqual([{ type: "del", text: "기존 내용" }]);
  });

  it("변경된 단어를 삭제/추가로 구분하고 유지분은 same", () => {
    const segments = diffTexts("hello world", "hello there");
    expect(segments).toEqual([
      { type: "same", text: "hello " },
      { type: "del", text: "world" },
      { type: "add", text: "there" },
    ]);
  });

  it("추가된 문장은 add 로 드러난다", () => {
    const segments = diffTexts(
      "첫 문장입니다.",
      "첫 문장입니다.\n두 번째 문장을 추가했어요.",
    );
    // 유지분 + 개행 + 추가분이 이어져 add 로 취합될 수 있다.
    expect(segments.some((s) => s.type === "add")).toBe(true);
    expect(segments.some((s) => s.type === "del")).toBe(false);
  });

  it("삭제된 문장은 del 로 드러난다", () => {
    const segments = diffTexts(
      "안녕하세요.\n삭제될 문장.",
      "안녕하세요.",
    );
    expect(segments.some((s) => s.type === "del")).toBe(true);
    expect(segments.some((s) => s.type === "add")).toBe(false);
  });
});