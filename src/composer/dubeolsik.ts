// 두벌식 최종 자판: 물리 키 → 자모
export const KEY_TO_JAMO: Record<string, string> = {
  q: "ㅂ",
  w: "ㅈ",
  e: "ㄷ",
  r: "ㄱ",
  t: "ㅅ",
  y: "ㅛ",
  u: "ㅕ",
  i: "ㅑ",
  o: "ㅐ",
  p: "ㅔ",
  a: "ㅁ",
  s: "ㄴ",
  d: "ㅇ",
  f: "ㄹ",
  g: "ㅎ",
  h: "ㅗ",
  j: "ㅓ",
  k: "ㅏ",
  l: "ㅣ",
  z: "ㅋ",
  x: "ㅌ",
  c: "ㅊ",
  v: "ㅍ",
  b: "ㅠ",
  n: "ㅜ",
  m: "ㅡ",
};
// Shift 자판: 쌍자음 (Q=ㅃ W=ㅉ R=ㄲ T=ㅆ F=ㄸ)
export const SHIFT_KEY_TO_JAMO: Record<string, string> = {
  Q: "ㅃ",
  W: "ㅉ",
  R: "ㄲ",
  T: "ㅆ",
  F: "ㄸ",
};
export const JAMO_TO_KEY: Record<string, string> = {
  ㅂ: "q",
  ㅈ: "w",
  ㄷ: "e",
  ㄱ: "r",
  ㅅ: "t",
  ㅛ: "y",
  ㅕ: "u",
  ㅑ: "i",
  ㅐ: "o",
  ㅔ: "p",
  ㅁ: "a",
  ㄴ: "s",
  ㅇ: "d",
  ㄹ: "f",
  ㅎ: "g",
  ㅗ: "h",
  ㅓ: "j",
  ㅏ: "k",
  ㅣ: "l",
  ㅋ: "z",
  ㅌ: "x",
  ㅊ: "c",
  ㅍ: "v",
  ㅠ: "b",
  ㅜ: "n",
  ㅡ: "m",
};
export const JAMO_TO_SHIFT_KEY: Record<string, string> = {
  ㅃ: "Q",
  ㅉ: "W",
  ㄲ: "R",
  ㅆ: "T",
  ㄸ: "F",
};
// 겹자모 → 키 2개
export const COMPOUND_JUNO_TO_KEYS: Record<string, string> = {
  ㅘ: "hk",
  ㅙ: "ho",
  ㅚ: "hl",
  ㅝ: "nj",
  ㅞ: "np",
  ㅟ: "nl",
  ㅢ: "ml",
  ㄳ: "rt",
  ㄵ: "sw",
  ㄶ: "sg",
  ㄺ: "fr",
  ㄻ: "fa",
  ㄼ: "fq",
  ㄽ: "ft",
  ㄾ: "fx",
  ㄿ: "fv",
  ㅀ: "fg",
  ㅄ: "qt",
};

export const CHOSEONG = [
  "ㄱ",
  "ㄲ",
  "ㄴ",
  "ㄷ",
  "ㄸ",
  "ㄹ",
  "ㅁ",
  "ㅂ",
  "ㅃ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅉ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
];
export const JUNGSEONG = [
  "ㅏ",
  "ㅐ",
  "ㅑ",
  "ㅒ",
  "ㅓ",
  "ㅔ",
  "ㅕ",
  "ㅖ",
  "ㅗ",
  "ㅘ",
  "ㅙ",
  "ㅚ",
  "ㅛ",
  "ㅜ",
  "ㅝ",
  "ㅞ",
  "ㅟ",
  "ㅠ",
  "ㅡ",
  "ㅢ",
  "ㅣ",
];
export const JONGSEONG = [
  "",
  "ㄱ",
  "ㄲ",
  "ㄳ",
  "ㄴ",
  "ㄵ",
  "ㄶ",
  "ㄷ",
  "ㄹ",
  "ㄺ",
  "ㄻ",
  "ㄼ",
  "ㄽ",
  "ㄾ",
  "ㄿ",
  "ㅀ",
  "ㅁ",
  "ㅂ",
  "ㅄ",
  "ㅅ",
  "ㅆ",
  "ㅇ",
  "ㅈ",
  "ㅊ",
  "ㅋ",
  "ㅌ",
  "ㅍ",
  "ㅎ",
];

export function decomposeSyllable(
  ch: string,
): { cho: string; jung: string; jong: string } | null {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code >= 11172) return null;
  const jongIdx = code % 28;
  const rest = (code - jongIdx) / 28;
  const jungIdx = rest % 21;
  const choIdx = (rest - jungIdx) / 21;
  return {
    cho: CHOSEONG[choIdx],
    jung: JUNGSEONG[jungIdx],
    jong: JONGSEONG[jongIdx],
  };
}

export function composeSyllable(cho: string, jung: string, jong = ""): string {
  const ci = CHOSEONG.indexOf(cho);
  const ji = JUNGSEONG.indexOf(jung);
  const jj = JONGSEONG.indexOf(jong);
  if (ci < 0 || ji < 0 || jj < 0) return cho + jung + jong; // 조합 불가능 → 자모 나열
  return String.fromCharCode(0xac00 + (ci * 21 + ji) * 28 + jj);
}

// 한글 → 두벌식 물리 키 문자열 (역방향)
export function hangulToKeys(text: string): string {
  let out = "";
  for (const ch of text) {
    const d = decomposeSyllable(ch);
    if (!d) {
      out += ch;
      continue;
    }
    out += JAMO_TO_KEY[d.cho] ?? JAMO_TO_SHIFT_KEY[d.cho] ?? d.cho;
    out += COMPOUND_JUNO_TO_KEYS[d.jung] ?? JAMO_TO_KEY[d.jung] ?? d.jung;
    if (d.jong)
      out += COMPOUND_JUNO_TO_KEYS[d.jong] ?? JAMO_TO_KEY[d.jong] ?? d.jong;
  }
  return out;
}

// 겹자모 조합/분해: [첫 자모, 둘째 자모]
const COMPOUND_JUNG: Record<string, [string, string]> = {
  ㅘ: ["ㅗ", "ㅏ"],
  ㅙ: ["ㅗ", "ㅐ"],
  ㅚ: ["ㅗ", "ㅣ"],
  ㅝ: ["ㅜ", "ㅓ"],
  ㅞ: ["ㅜ", "ㅔ"],
  ㅟ: ["ㅜ", "ㅣ"],
  ㅢ: ["ㅡ", "ㅣ"],
};
const COMPOUND_JONG: Record<string, [string, string]> = {
  ㄳ: ["ㄱ", "ㅅ"],
  ㄵ: ["ㄴ", "ㅈ"],
  ㄶ: ["ㄴ", "ㅎ"],
  ㄺ: ["ㄹ", "ㄱ"],
  ㄻ: ["ㄹ", "ㅁ"],
  ㄼ: ["ㄹ", "ㅂ"],
  ㄽ: ["ㄹ", "ㅅ"],
  ㄾ: ["ㄹ", "ㅌ"],
  ㄿ: ["ㄹ", "ㅍ"],
  ㅀ: ["ㄹ", "ㅎ"],
  ㅄ: ["ㅂ", "ㅅ"],
};
const JUNG_TO_COMPOUND: Record<string, string> = Object.fromEntries(
  Object.entries(COMPOUND_JUNG).map(([k, [a, b]]) => [`${a}${b}`, k]),
);
const JONG_TO_COMPOUND: Record<string, string> = Object.fromEntries(
  Object.entries(COMPOUND_JONG).map(([k, [a, b]]) => [`${a}${b}`, k]),
);

// 모음/자음 분류 (복합 겹자모 포함)
const JUNGS: Set<string> = new Set(JUNGSEONG);
const SINGLE_JONG = JONGSEONG.filter((j) => j.length === 1);

export interface HangulBuffer {
  cho: string | null;
  jung: string | null;
  jong: string | null;
}
export const EMPTY_BUFFER: HangulBuffer = { cho: null, jung: null, jong: null };

// 자모 하나를 버퍼에 반영, 새로 완성된 글자(들) 반환
export function pushJamo(buf: HangulBuffer, jamo: string): string {
  if (JUNGS.has(jamo)) {
    // 모음
    if (buf.cho === null) {
      if (buf.jung === null) {
        buf.jung = jamo;
        return "";
      }
      const merged = JUNG_TO_COMPOUND[buf.jung + jamo];
      if (merged) {
        const out = composeSyllable("", buf.jung, "");
        buf.jung = merged;
        return out;
      }
      const out = composeSyllable("", buf.jung, "");
      buf.jung = jamo;
      return out;
    }
    if (buf.jung === null) {
      buf.jung = jamo;
      return "";
    }
    if (buf.jong === null) {
      const merged = JUNG_TO_COMPOUND[buf.jung + jamo];
      if (merged) {
        buf.jung = merged;
        return "";
      } // ㅗ+ㅏ → ㅘ
      return flush(buf, jamo);
    }
    // 종성 보유 + 모음 → **종성 이동**: 단일 종성은 다음 초성으로,
    // 겹종성은 첫 자모만 남기고 둘째 자모가 다음 초성으로 (하+ㅅ+ㅔ → 하세)
    const parts = COMPOUND_JONG[buf.jong];
    if (!parts) {
      const out = composeSyllable(buf.cho ?? "", buf.jung ?? "", "");
      buf.cho = buf.jong;
      buf.jung = jamo;
      buf.jong = null;
      return out;
    }
    const out = composeSyllable(buf.cho ?? "", buf.jung ?? "", parts[0]);
    buf.cho = parts[1];
    buf.jung = jamo;
    buf.jong = null;
    return out;
  }
  // 자음
  if (buf.cho === null) {
    if (buf.jung !== null) {
      buf.cho = jamo;
      return "";
    } // 단독 모음 ㅏ 후 ㄱ → 아
    buf.cho = jamo;
    return "";
  }
  if (buf.jung === null) return flush(buf, jamo); // 초성 연속 → 분리
  if (buf.jong === null) {
    if (!SINGLE_JONG.includes(jamo)) return flush(buf, jamo); // ㅃ/ㅉ/ㄸ 종성 불가
    buf.jong = jamo;
    return "";
  }
  const merged = JONG_TO_COMPOUND[buf.jong + jamo];
  if (merged) {
    buf.jong = merged;
    return "";
  } // ㄱ+ㅅ → ㄳ
  return flush(buf, jamo);
}

function flush(buf: HangulBuffer, nextJamo?: string): string {
  const out = composeSyllable(buf.cho ?? "", buf.jung ?? "", buf.jong ?? "");
  buf.cho = JUNGS.has(nextJamo ?? "") ? null : (nextJamo ?? null);
  buf.jung = JUNGS.has(nextJamo ?? "") ? (nextJamo ?? null) : null;
  buf.jong = null;
  return out;
}

// 전체 키 문자열 → 한글 (스페이스는 단어 경계로 보존)
export function keysToHangul(keys: string): string {
  const buf: HangulBuffer = { ...EMPTY_BUFFER };
  let out = "";
  for (const k of keys) {
    if (k === " ") {
      out += flush(buf);
      out += " ";
      continue;
    }
    const jamo = SHIFT_KEY_TO_JAMO[k] ?? KEY_TO_JAMO[k.toLowerCase()];
    if (!jamo) continue; // 매핑 밖 키는 무시 (호출부에서 처리)
    out += pushJamo(buf, jamo);
  }
  out += composeSyllable(buf.cho ?? "", buf.jung ?? "", buf.jong ?? "");
  return out;
}
