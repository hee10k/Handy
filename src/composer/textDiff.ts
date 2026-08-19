// 텍스트 diff (ticket 05) — 의존성 없는 워드 단위 diff.
//
// 원문(v0)과 현재 결과를 비교해 추가/유지/삭제 세그먼트로 나눈다. 기준은
// 단어 토큰(공백 포함) 수준의 LCS 로, 문장·문단 단위로 AI 가 무얼 바꿨는지
// 검토하기에 충분하다. 외부 라이브러리 없이 순수 함수로 구현.

export type DiffSegmentType = "same" | "add" | "del";

export interface DiffSegment {
  type: DiffSegmentType;
  text: string;
}

/** 공백·줄바꿈을 보존하며 토큰화: "a bc\n d" → ["a"," ","bc","\n"," ","d"] */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/** LCS 세그먼트 생성 (워드 토큰 단위) */
export function diffTexts(original: string, current: string): DiffSegment[] {
  if (original === current) {
    return current.length > 0 ? [{ type: "same", text: current }] : [];
  }
  if (original.length === 0) {
    return current.length > 0 ? [{ type: "add", text: current }] : [];
  }
  if (current.length === 0) {
    return original.length > 0 ? [{ type: "del", text: original }] : [];
  }

  const a = tokenize(original);
  const b = tokenize(current);

  // lcs[i][j] = a[i:] 와 b[j:] 의 LCS 길이 (일반맞춤 LCS).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // 세그먼트를 만들고 인접한 같은 종류는 병합한다.
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;

  const push = (type: DiffSegmentType, text: string) => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.type === type) {
      last.text += text;
    } else {
      segments.push({ type, text });
    }
  };

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] > lcs[i + 1][j])) {
      push("add", b[j]);
      j++;
    } else {
      push("del", a[i]);
      i++;
    }
  }

  return segments;
}