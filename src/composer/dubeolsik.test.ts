import { describe, expect, it } from "vitest";
import {
  composeSyllable,
  decomposeSyllable,
  hangulToKeys,
  keysToHangul,
} from "./dubeolsik";

describe("decomposeSyllable", () => {
  it("안 → ㅇ/ㅏ/ㄴ", () => {
    expect(decomposeSyllable("안")).toEqual({
      cho: "ㅇ",
      jung: "ㅏ",
      jong: "ㄴ",
    });
  });
  it("왜 → ㅇ/ㅙ/'' (겹중성)", () => {
    expect(decomposeSyllable("왜")).toEqual({
      cho: "ㅇ",
      jung: "ㅙ",
      jong: "",
    });
  });
  it("값 → ㄱ/ㅏ/ㅄ (겹종성)", () => {
    expect(decomposeSyllable("값")).toEqual({
      cho: "ㄱ",
      jung: "ㅏ",
      jong: "ㅄ",
    });
  });
});

describe("composeSyllable", () => {
  it("ㅇ+ㅏ+ㄴ → 안", () =>
    expect(composeSyllable("ㅇ", "ㅏ", "ㄴ")).toBe("안"));
  it("조합 불가 시 자모 나열", () =>
    expect(composeSyllable("ㄴ", "ㅏ", "ㅃ")).toBe("ㄴㅏㅃ"));
});

// 실측 검증된 왕복 벡터 (2026-10-09 eval 30/30 PASS — 추측값 아님)
const ROUNDTRIP: Array<[string, string]> = [
  ["안녕하세요", "dkssudgktpdy"],
  ["학교", "gkrry"],
  ["값", "rkqt"],
  ["왜", "dho"],
  ["닭", "ekfr"],
  ["앉아", "dkswdk"],
  ["넓다", "sjfqek"],
  ["싸다", "Tkek"],
  ["한글", "gksrmf"],
  ["컴퓨터", "zjavbxj"],
  ["사랑해", "tkfkdgo"],
  ["반갑습니다", "qksrkqtmqslek"],
  ["타자기", "xkwkrl"],
  ["오늘은", "dhsmfdms"],
  ["조회수", "whghltn"],
  ["꿀벌", "Rnfqjf"],
  ["뷁", "qnpfr"],
  ["읊다", "dmfvek"],
  ["갈색", "rkftor"],
  ["사과", "tkrhk"],
  ["봄", "qha"],
  ["여름", "dufma"],
  ["겨울", "rudnf"],
  ["기차", "rlck"],
  ["커피", "zjvl"],
  ["바다", "qkek"],
  ["달", "ekf"],
  ["별", "quf"],
  ["산", "tks"],
  ["안녕 하세요", "dkssud gktpdy"],
];

describe("roundtrip", () => {
  it.each(ROUNDTRIP)("hangul=%j keys=%j 양방향 일치", (hangul, keys) => {
    expect(hangulToKeys(hangul)).toBe(keys);
    expect(keysToHangul(keys)).toBe(hangul);
  });
});
