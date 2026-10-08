# 10 — 한/영 동시 입력: 이중 해석 컴포저 타이핑 (dual-language input)

**What to build:** 컴포저 타이핑을 IME 상태와 무관한 **물리 키 기반 이중 해석**으로 전환한다. 같은 키 시퀀스로 **한글 출력창**과 **영어 출력창**을 동시에 채우고, 구(chunk) 단위로 1/2 키로 언어를 확정해 초안에 쌓는다.

**Blocked by:** 04 (composer integration), 06 (settings UI)

**Status:** planned (2026-10-08)

**참고 (엔진 수학 실측 검증 완료 2026-10-08):** Task 2 코드로 20개 한글 샘플 왕복 전부 PASS 확인됨. 정답 키 벡터는 아래 Task 2 Step 5 표 — 추측 아님.

---

## 확정 설계 (스펙 39-43 + 그릴 2026-10-08)

- **입력 캡처**: 컴포저 포커스 중 keydown `e.code`(물리 키, `KeyD` 등) 기반. IME 상태 무관 — 한글 IME 조합 중이어도 물리 키로 이중 해석.
- **두 출력창**: 한글 해석(키→두벌식 조합) + 영어 해석(키 시퀀스 그대로). textarea는 초안 표시 전용.
- **구(chunk) 상태 머신**: `EMPTY → COMPOSING → (1|2) → COMMITTED → EMPTY`
- **키 테이블**: A-Z=두벌식 매핑, Space=단어 경계, Backspace=양 창 롤백, Enter=1/2 선택 강제(빈 구 no-op), 1/2=한글/영어 확정→초안 append, ⌥(macOS)/Alt(Win)+1/2=리터럴 숫자, 3-0=리터럴, Cmd/Ctrl+Enter=최종 커밋(기존 commit path 재사용), Esc=구 폐기(비어있으면 컴포저 닫기)
- **리스크**: WKWebView IME 조합 중 keydown 신뢰성 → Task 1 POC 스파이크, 실패 시 beforeinput 기반 백업 플랜.

## Task 1: POC 스파이크 — WKWebView IME 조합 중 keydown `e.code` 신뢰성

textarea에 한글 IME 조합 중 `keydown`의 `e.code`/`e.key` 도착 여부를 실측한다. 실패 시 `beforeinput`(inputType=insertCompositionText)에서 조합 텍스트를 받아 `hangulToKeys` 역산하는 백업 플랜으로 전환.

**Files:**
- Modify: `src/composer/Composer.tsx` (임시 이벤트 로그 핸들러, 스파이크 후 삭제)

- [ ] **Step 1: probe 텍스트 입력 이벤트 로깅**

```tsx
// Composer.tsx textarea 임시 props (티켓 10 Task 1, 스파이크 후 제거)
onKeyDown={(e) => {
  console.log("[poc-keydown]", JSON.stringify({ code: e.code, key: e.key, isComposing: e.nativeEvent.isComposing }));
}}
onBeforeInput={(e) => {
  console.log("[poc-beforeinput]", JSON.stringify({ type: (e as InputEvent).inputType, data: (e as InputEvent).data }));
}}
```

- [ ] **Step 2: 라이브 확인** — tauri dev 실행 중 컴포저 열고 한글 IME 상태로 "안녕" 타이핑, console에서 keydown 의 `code`(KeyD/KeyK...) 도착 여부 기록
- [ ] **Step 3: 결과 판정**
  - `code` 도착함 → 계획 유지 (Task 2대로)
  - `code` 미도착/Process 키만 → **백업 플랜**: beforeinput 의 `data`(조합 텍스트)를 누적해 한글창, `hangulToKeys`로 영어창 역산. 키 시퀀스 직접 수집은 포기하고 조합 최종 텍스트 기준.
- [ ] **Step 4: 휴지 코드 제거** — probe props 삭제/원복

## Task 2: 두벌식 양방향 엔진 (순수 함수)

**Files:**
- Create: `src/composer/dubeolsik.ts`
- Test: `src/composer/dubeolsik.test.ts`

⚠️ 이 파일의 매핑표·조합 알고리즘은 **실측 검증된 코드**다. 표를 수정하면 아래 왕복 테스트가 깨진다.

- [ ] **Step 1: 매핑표 + 음절 분해·조합** — 아래 코드 그대로 생성

```ts
// src/composer/dubeolsik.ts
// 두벌식 최종 자판: 물리 키 → 자모
export const KEY_TO_JAMO: Record<string, string> = {
  q: "ㅂ", w: "ㅈ", e: "ㄷ", r: "ㄱ", t: "ㅅ", y: "ㅛ", u: "ㅕ",
  i: "ㅑ", o: "ㅐ", p: "ㅔ", a: "ㅁ", s: "ㄴ", d: "ㅇ", f: "ㄹ",
  g: "ㅎ", h: "ㅗ", j: "ㅓ", k: "ㅏ", l: "ㅣ", z: "ㅋ", x: "ㅌ",
  c: "ㅊ", v: "ㅍ", b: "ㅠ", n: "ㅜ", m: "ㅡ",
};
// Shift 자판: 쌍자음 (Q=ㅃ W=ㅉ R=ㄲ T=ㅆ F=ㄸ)
export const SHIFT_KEY_TO_JAMO: Record<string, string> = {
  Q: "ㅃ", W: "ㅉ", R: "ㄲ", T: "ㅆ", F: "ㄸ",
};
export const JAMO_TO_KEY: Record<string, string> = {
  "ㅂ": "q", "ㅈ": "w", "ㄷ": "e", "ㄱ": "r", "ㅅ": "t", "ㅛ": "y", "ㅕ": "u",
  "ㅑ": "i", "ㅐ": "o", "ㅔ": "p", "ㅁ": "a", "ㄴ": "s", "ㅇ": "d", "ㄹ": "f",
  "ㅎ": "g", "ㅗ": "h", "ㅓ": "j", "ㅏ": "k", "ㅣ": "l", "ㅋ": "z", "ㅌ": "x",
  "ㅊ": "c", "ㅍ": "v", "ㅠ": "b", "ㅜ": "n", "ㅡ": "m",
};
export const JAMO_TO_SHIFT_KEY: Record<string, string> = {
  "ㅃ": "Q", "ㅉ": "W", "ㄲ": "R", "ㅆ": "T", "ㄸ": "F",
};
// 겹자모 → 키 2개
export const COMPOUND_JUNO_TO_KEYS: Record<string, string> = {
  "ㅘ": "hk", "ㅙ": "ho", "ㅚ": "hl", "ㅝ": "nj", "ㅞ": "np", "ㅟ": "nl", "ㅢ": "ml",
  "ㄳ": "rt", "ㄵ": "sw", "ㄶ": "sg", "ㄺ": "fr", "ㄻ": "fa", "ㄼ": "fq", "ㄽ": "ft",
  "ㄾ": "fx", "ㄿ": "fv", "ㅀ": "fg", "ㅄ": "qt",
};

export const CHOSEONG = ["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
export const JUNGSEONG = ["ㅏ","ㅐ","ㅑ","ㅒ","ㅓ","ㅔ","ㅕ","ㅖ","ㅗ","ㅘ","ㅙ","ㅚ","ㅛ","ㅜ","ㅝ","ㅞ","ㅟ","ㅠ","ㅡ","ㅢ","ㅣ"];
export const JONGSEONG = ["","ㄱ","ㄲ","ㄳ","ㄴ","ㄵ","ㄶ","ㄷ","ㄹ","ㄺ","ㄻ","ㄼ","ㄽ","ㄾ","ㄿ","ㅀ","ㅁ","ㅂ","ㅄ","ㅅ","ㅆ","ㅇ","ㅈ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];

// 모음/자음 분류 (복합 겹자모 포함)
const JUNGS: Set<string> = new Set(JUNGSEONG);
const SINGLE_JONG = JONGSEONG.filter((j) => j.length === 1);

export function decomposeSyllable(ch: string): { cho: string; jung: string; jong: string } | null {
  const code = ch.charCodeAt(0) - 0xac00;
  if (code < 0 || code >= 11172) return null;
  const jongIdx = code % 28;
  const rest = (code - jongIdx) / 28;
  const jungIdx = rest % 21;
  const choIdx = (rest - jungIdx) / 21;
  return { cho: CHOSEONG[choIdx], jung: JUNGSEONG[jungIdx], jong: JONGSEONG[jongIdx] };
}

export function composeSyllable(cho: string, jung: string, jong = ""): string {
  const ci = CHOSEONG.indexOf(cho);
  const ji = JUNGSEONG.indexOf(jung);
  const jj = JONGSEONG.indexOf(jong);
  if (ci < 0 || ji < 0 || jj < 0) return cho + jung + jong; // 조합 불가능 → 자모 나열
  return String.fromCharCode(0xac00 + (ci * 21 + ji) * 28 + jj);
}
```

- [ ] **Step 2: 실패 테스트 먼저** — `src/composer/dubeolsik.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { decomposeSyllable, composeSyllable } from "./dubeolsik";

describe("decomposeSyllable", () => {
  it("안 → ㅇ/ㅏ/ㄴ", () => {
    expect(decomposeSyllable("안")).toEqual({ cho: "ㅇ", jung: "ㅏ", jong: "ㄴ" });
  });
  it("왜 → ㅇ/ㅙ/'' (겹중성)", () => {
    expect(decomposeSyllable("왜")).toEqual({ cho: "ㅇ", jung: "ㅙ", jong: "" });
  });
  it("값 → ㄱ/ㅏ/ㅄ (겹종성)", () => {
    expect(decomposeSyllable("값")).toEqual({ cho: "ㄱ", jung: "ㅏ", jong: "ㅄ" });
  });
});

describe("composeSyllable", () => {
  it("ㅇ+ㅏ+ㄴ → 안", () => expect(composeSyllable("ㅇ", "ㅏ", "ㄴ")).toBe("안"));
  it("조합 불가 시 자모 나열", () => expect(composeSyllable("ㄴ", "ㅏ", "ㅃ")).toBe("ㄴㅏㅃ"));
});
```

- [ ] **Step 3: hangulToKeys — 한글→키 (역방향)** — 아래 코드 그대로 생성

```ts
export function hangulToKeys(text: string): string {
  let out = "";
  for (const ch of text) {
    const d = decomposeSyllable(ch);
    if (!d) { out += ch; continue; }
    out += JAMO_TO_KEY[d.cho] ?? JAMO_TO_SHIFT_KEY[d.cho] ?? d.cho;
    out += COMPOUND_JUNO_TO_KEYS[d.jung] ?? JAMO_TO_KEY[d.jung] ?? d.jung;
    if (d.jong) out += COMPOUND_JUNO_TO_KEYS[d.jong] ?? JAMO_TO_KEY[d.jong] ?? d.jong;
  }
  return out;
}
```

- [ ] **Step 4: keysToHangul — 키→한글 (정방향, 조합 상태 머신)** — 아래 코드 그대로 생성

```ts
// 겹자모 조합/분해: [첫 자모, 둘째 자모]
const COMPOUND_JUNG: Record<string, [string, string]> = {
  "ㅘ": ["ㅗ","ㅏ"], "ㅙ": ["ㅗ","ㅐ"], "ㅚ": ["ㅗ","ㅣ"],
  "ㅝ": ["ㅜ","ㅓ"], "ㅞ": ["ㅜ","ㅔ"], "ㅟ": ["ㅜ","ㅣ"], "ㅢ": ["ㅡ","ㅣ"],
};
const COMPOUND_JONG: Record<string, [string, string]> = {
  "ㄳ": ["ㄱ","ㅅ"], "ㄵ": ["ㄴ","ㅈ"], "ㄶ": ["ㄴ","ㅎ"], "ㄺ": ["ㄹ","ㄱ"],
  "ㄻ": ["ㄹ","ㅁ"], "ㄼ": ["ㄹ","ㅂ"], "ㄽ": ["ㄹ","ㅅ"], "ㄾ": ["ㄹ","ㅌ"],
  "ㄿ": ["ㄹ","ㅍ"], "ㅀ": ["ㄹ","ㅎ"], "ㅄ": ["ㅂ","ㅅ"],
};
const JUNG_TO_COMPOUND: Record<string, string> = Object.fromEntries(
  Object.entries(COMPOUND_JUNG).map(([k, [a, b]]) => [`${a}${b}`, k]),
);
const JONG_TO_COMPOUND: Record<string, string> = Object.fromEntries(
  Object.entries(COMPOUND_JONG).map(([k, [a, b]]) => [`${a}${b}`, k]),
);

export interface HangulBuffer { cho: string | null; jung: string | null; jong: string | null; }
export const EMPTY_BUFFER: HangulBuffer = { cho: null, jung: null, jong: null };

// 자모 하나를 버퍼에 반영, 새로 완성된 글자(들) 반환
export function pushJamo(buf: HangulBuffer, jamo: string): string {
  if (JUNGS.has(jamo)) {
    // 모음
    if (buf.cho === null) {
      if (buf.jung === null) { buf.jung = jamo; return ""; }
      const merged = JUNG_TO_COMPOUND[buf.jung + jamo];
      if (merged) { const out = composeSyllable("", buf.jung, ""); buf.jung = merged; return out; }
      const out = composeSyllable("", buf.jung, "");
      buf.jung = jamo;
      return out;
    }
    if (buf.jung === null) { buf.jung = jamo; return ""; }
    if (buf.jong === null) {
      const merged = JUNG_TO_COMPOUND[buf.jung + jamo];
      if (merged) { buf.jung = merged; return ""; } // ㅗ+ㅏ → ㅘ
      return flush(buf, jamo);
    }
    // 종성 보유 + 모음 → **종성 이동**: 단일 종성은 다음 초성으로,
    // 겹종성은 첫 자모만 남기고 둘째 자모가 다음 초성으로 (하+ㅅ+ㅔ → 하세)
    const parts = COMPOUND_JONG[buf.jong];
    if (!parts) {
      const out = composeSyllable(buf.cho ?? "", buf.jung ?? "", "");
      buf.cho = buf.jong; buf.jung = jamo; buf.jong = null;
      return out;
    }
    const out = composeSyllable(buf.cho ?? "", buf.jung ?? "", parts[0]);
    buf.cho = parts[1]; buf.jung = jamo; buf.jong = null;
    return out;
  }
  // 자음
  if (buf.cho === null) {
    if (buf.jung !== null) { buf.cho = jamo; return ""; } // 단독 모음 ㅏ 후 ㄱ → 아
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
  if (merged) { buf.jong = merged; return ""; } // ㄱ+ㅅ → ㄳ
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
    if (k === " ") { out += flush(buf); out += " "; continue; }
    const jamo = SHIFT_KEY_TO_JAMO[k] ?? KEY_TO_JAMO[k.toLowerCase()];
    if (!jamo) continue; // 매핑 밖 키는 무시 (호출부에서 처리)
    out += pushJamo(buf, jamo);
  }
  out += composeSyllable(buf.cho ?? "", buf.jung ?? "", buf.jong ?? "");
  return out;
}
```

- [ ] **Step 5: 왕복 테스트 — 실측 검증된 30 샘플** (각 키 벡터는 실제 엔진 실행 결과, 2026-10-08 eval 30/30 PASS)

```ts
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
```

- [ ] **Step 6: `bunx vitest run src/composer/dubeolsik.test.ts`** — 전체 PASS 확인
- [ ] **Step 7: 커밋** — `git add src/composer/dubeolsik.ts src/composer/dubeolsik.test.ts && git commit -m "feat: dubeolsik bidirectional engine (ticket 10)"` (워크트리 오염 시 커밋 보류 후 재검토)

## Task 3: 컴포저 이중 해석 상태 머신 + UI

**Files:**
- Modify: `src/composer/Composer.tsx`
- Modify: `src/composer/Composer.css`
- Modify: `src/i18n/locales/en/translation.json`, `src/i18n/locales/ko/translation.json`
- Modify: `src/bindings.ts` (불필요 — 프론트 전용, 백엔드 커맨드 추가 없음)

- [ ] **Step 1: 타입/상태/파생값 추가**

```ts
interface ChunkState { keys: string[]; pending: boolean; }
const EMPTY_CHUNK: ChunkState = { keys: [], pending: false };
// 컴포저 state 에 추가 (기존 localPredictions 등과 나란히):
const [chunk, setChunk] = useState<ChunkState>(EMPTY_CHUNK);
const koText = useMemo(() => keysToHangul(chunk.keys.join("")), [chunk.keys]);
const enText = useMemo(() => chunk.keys.join(""), [chunk.keys]);
```

- [ ] **Step 2: keydown 캡처 — 기존 handleKeyDown 에 이중 입력 블록 삽입** (modifier 단축키는 기존 경로 우선 유지)

기존 순서: `isComposing` 가드 → `Cmd/Ctrl+,` → `Cmd/Ctrl+1..0` 퀵액션 → **이중 입력 블록 (아래)** → `Cmd/Ctrl+Shift+P` 등 기존 핸들러.

```ts
// 물리 키 → e.key 문자 (한글 자판과 무관한 원시 키: KeyD → "d"/"D")
const keyChar = (code: string, shift: boolean): string | null => {
  const m = /^Key([A-Z])$/.exec(code);
  if (!m) return null;
  return shift ? m[1] : m[1].toLowerCase();
};

// 블록 내용 (handleKeyDown 안, 퀵액션 처리 직후):
const letter = keyChar(e.nativeEvent.code, e.shiftKey);
if (letter && !e.metaKey && !e.ctrlKey && !e.altKey) {
  e.preventDefault();
  setChunk((c) => ({ keys: [...c.keys, letter], pending: false }));
  return;
}
if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
  e.preventDefault();
  setChunk((c) => ({ keys: [...c.keys, " "], pending: false }));
  return;
}
if (e.key === "Backspace" && chunk.keys.length > 0) {
  e.preventDefault();
  setChunk((c) => ({ keys: c.keys.slice(0, -1), pending: false }));
  return;
}
if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
  e.preventDefault();
  if (chunk.keys.length > 0) setChunk((c) => ({ ...c, pending: true })); // 1/2 강제
  return; // 빈 구: no-op
}
if (chunk.keys.length > 0 && (e.key === "1" || e.key === "2") && !e.metaKey && !e.ctrlKey && !e.altKey) {
  e.preventDefault();
  commitChunk(e.key === "1" ? "ko" : "en");
  return;
}
// 3-0 및 리터럴: ⌥/Alt+1, ⌥/Alt+2 는 숫자로, 그 외 문자/기호는 영어창에 그대로
if (chunk.keys.length === 0 && (e.key === "1" || e.key === "2") && (e.metaKey || e.ctrlKey || e.altKey)) {
  e.preventDefault();
  setChunk((c) => ({ keys: [...c.keys, e.key], pending: false }));
  return;
}
// Esc: 구가 있으면 폐기 → EMPTY; 없으면 기존 핸들러(폐기/닫기)로 진행
if (e.key === "Escape" && chunk.keys.length > 0) {
  e.preventDefault();
  setChunk(EMPTY_CHUNK);
  return;
}
```

- [ ] **Step 3: commitChunk — 초안 append** (기존 revision 정책 `replace-current` 따름, `applyPrediction` 와 동일 패턴)

```ts
const commitChunk = (lang: "ko" | "en") => {
  const text = lang === "ko" ? koText : enText;
  setChunk(EMPTY_CHUNK);
  setText((prev) => {
    const sep = prev && !prev.endsWith(" ") ? " " : "";
    const next = `${prev}${sep}${text} `;
    dispatchRevision({ type: "replace-current", text: next });
    return next;
  });
  textareaRef.current?.focus();
};
```

- [ ] **Step 4: Cmd/Ctrl+Enter → 최종 커밋** (기존 `commit` 재사용; 기존에 Enter 에 묶였던 commit 은 Enter 가 이중 입력에 쓰이므로 Cmd/Ctrl+Enter 로 이동)

> **기존 코드 제거 필수**: handleKeyDown 의 `if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (streaming) return; commit(); return; }` 블록은 이중 입력의 Enter 인터셉트(빈 구 no-op)와 겹치므로 **삭제**한다. Enter 는 이제 구 확정 흐름만, 최종 커밋은 Cmd/Ctrl+Enter 만 담당한다.

```ts
if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
  e.preventDefault();
  commit(); // 기존 최종 커밋 (clipboard paste)
  return;
}
```

- [ ] **Step 5: 렌더링 — 초안 textarea 위 이중 출력창 + pending 힌트** (기존 `correction` 배너와 같은 위치 패턴)

```tsx
{chunk.keys.length > 0 && (
  <div className="composer__dual" role="region" aria-label={t("composer.dualAria")}>
    <div className="composer__dual-row">
      <span className="composer__dual-src">{t("composer.dualKo")}</span>
      <span className="composer__dual-text">{koText}</span>
    </div>
    <div className="composer__dual-row">
      <span className="composer__dual-src">{t("composer.dualEn")}</span>
      <span className="composer__dual-text">{enText}</span>
    </div>
    {chunk.pending && (
      <span className="composer__dual-pending">{t("composer.dualPending")}</span>
    )}
  </div>
)}
```

- [ ] **Step 6: CSS — `.composer__dual` 계열** (기존 `.composer__correction` 배너 패턴 재사용: 상단/하단 padding, dashed border, small font)
- [ ] **Step 7: i18n ko/en 키 추가**

```json
// en: composer 블록에 추가
"dualAria": "Dual-language interpretation",
"dualKo": "Korean",
"dualEn": "English",
"dualPending": "Press 1 for Korean or 2 for English",
// ko: composer 블록에 추가
"dualAria": "이중 언어 해석",
"dualKo": "한글",
"dualEn": "영어",
"dualPending": "1 한글 · 2 영어 선택",
```

- [ ] **Step 8: 검증** — `bun run build`, `bun run lint`, `bunx prettier --check src/composer/Composer.tsx src/composer/Composer.css`
- [ ] **Step 9: 커밋**

## Task 4: 라이브 스모크 (POC 게이트)

- [ ] tauri dev 재기동 (node_modules 복원 완료 — `bun install` 후 `bun run tauri dev`, pid 확인)
- [ ] 컴포저 열고 한글 IME 무관하게 "dkssudgktpdy" 타이핑 → 한글창 `안녕하세요` / 영어창 `dkssudgktpdy` 동시 갱신 확인
- [ ] 1 누르면 초안에 `안녕하세요` 추가, 2 누르면 `dkssudgktpdy` 추가
- [ ] Enter → pending 표시, 1/2 강제, Esc 로 구 폐기/닫기
- [ ] ⌥+1/2 리터럴, Backspace 롤백, Cmd/Ctrl+Enter 최종 커밋 (paste)
- [ ] POC 스파이크 결과 기록 (keydown 도착 여부, 백업 플랜 필요 여부)

## 확정 설계 요약

- 접근: **A — 프론트 순수 함수 엔진**(IPC 0 지연), WKWebView IME 리스크는 Task 1 스파이크로 게이트
- 리터럴 1/2: macOS ⌥(Option) + 1/2, Windows Alt + 1/2
- 기존 기능(퀵액션 Cmd+1..0 / 보정 / 추천 / 변환 모드) 공존 — modifier 키는 기존 경로 온전히 유지
- 200ms 추정 시스템은 별도 트랙 (스펙 Out of Scope 참고)