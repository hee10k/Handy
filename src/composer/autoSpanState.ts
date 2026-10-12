import { keysToHangul } from "./dubeolsik";
import type {
  AutoInputDecision,
  AutoInputSpan,
  AutoLanguage,
} from "@/bindings";

export interface AutoSpan {
  id: number;
  keys: string;
  ko: string;
  en: string;
  separator: string;
  language: AutoLanguage;
  isResolved: boolean;
  isOverridden: boolean;
  isPrefix?: boolean;
}

export interface AutoSpanSession {
  generation: number;
  nextSpanId: number;
  spans: AutoSpan[];
  activeKeys: string;
  trailingPreviewLanguage: AutoLanguage;
  trailingPreviewResolved: boolean;
  isResolving: boolean;
  error: string | null;
}

export const PUNCTUATION_BOUNDARIES = new Set([".", ",", "!", "?", ":", ";"]);

export function isWordBoundary(char: string): boolean {
  return char === " " || char === "\n" || PUNCTUATION_BOUNDARIES.has(char);
}

export function createInitialAutoSpanState(): AutoSpanSession {
  return {
    generation: 1,
    nextSpanId: 1,
    spans: [],
    activeKeys: "",
    trailingPreviewLanguage: "ko",
    trailingPreviewResolved: false,
    isResolving: false,
    error: null,
  };
}

export function resetAutoSpanSession(
  session?: AutoSpanSession,
): AutoSpanSession {
  const nextGen = session ? session.generation + 1 : 1;
  return {
    generation: nextGen,
    nextSpanId: 1,
    spans: [],
    activeKeys: "",
    trailingPreviewLanguage: "ko",
    trailingPreviewResolved: false,
    isResolving: false,
    error: null,
  };
}

export function inputKey(
  session: AutoSpanSession,
  key: string,
): {
  nextSession: AutoSpanSession;
  boundaryFlushed: boolean;
  flushedSpan: AutoSpan | null;
} {
  // Check if key is a boundary
  if (isWordBoundary(key)) {
    if (session.activeKeys.length > 0) {
      // Flush active keys into a new span with this boundary as separator
      const newSpan: AutoSpan = {
        id: session.nextSpanId,
        keys: session.activeKeys,
        ko: keysToHangul(session.activeKeys),
        en: session.activeKeys,
        separator: key,
        language: session.trailingPreviewLanguage,
        isResolved: false,
        isOverridden: false,
      };
      return {
        nextSession: {
          ...session,
          generation: session.generation + 1,
          trailingPreviewResolved: false,
          nextSpanId: session.nextSpanId + 1,
          spans: [...session.spans, newSpan],
          activeKeys: "",
          trailingPreviewLanguage: "ko",
        },
        boundaryFlushed: true,
        flushedSpan: newSpan,
      };
    }

    // Active keys is empty (e.g. repeated space or punctuation following word)
    if (session.spans.length > 0) {
      const lastIdx = session.spans.length - 1;
      const lastSpan = session.spans[lastIdx];
      const updatedSpans = [...session.spans];
      updatedSpans[lastIdx] = {
        ...lastSpan,
        separator: lastSpan.separator + key,
      };
      return {
        nextSession: {
          ...session,
          generation: session.generation + 1,
          trailingPreviewResolved: false,
          spans: updatedSpans,
        },
        boundaryFlushed: false,
        flushedSpan: null,
      };
    }

    // No spans yet, create leading separator span
    const leadingSpan: AutoSpan = {
      id: session.nextSpanId,
      keys: "",
      ko: "",
      en: "",
      separator: key,
      language: "ko",
      isResolved: true,
      isOverridden: false,
    };
    return {
      nextSession: {
        ...session,
        generation: session.generation + 1,
        trailingPreviewResolved: false,
        nextSpanId: session.nextSpanId + 1,
        spans: [leadingSpan],
      },
      boundaryFlushed: false,
      flushedSpan: null,
    };
  }

  // Not a boundary: append to active keys (letters, digits, symbols)
  // If activeKeys is empty but preceding span has separator: '' and non-empty keys,
  // extend that span into activeKeys.
  if (session.activeKeys.length === 0 && session.spans.length > 0) {
    const lastIdx = session.spans.length - 1;
    const lastSpan = session.spans[lastIdx];
    if (
      !lastSpan.isPrefix &&
      lastSpan.separator === "" &&
      lastSpan.keys.length > 0
    ) {
      return {
        nextSession: {
          ...session,
          generation: session.generation + 1,
          trailingPreviewResolved: false,
          spans: session.spans.slice(0, -1),
          activeKeys: lastSpan.keys + key,
          trailingPreviewLanguage: lastSpan.language,
        },
        boundaryFlushed: false,
        flushedSpan: null,
      };
    }
  }

  return {
    nextSession: {
      ...session,
      generation: session.generation + 1,
      trailingPreviewResolved: false,
      activeKeys: session.activeKeys + key,
    },
    boundaryFlushed: false,
    flushedSpan: null,
  };
}

export function handleBackspace(session: AutoSpanSession): AutoSpanSession {
  if (session.activeKeys.length > 0) {
    return {
      ...session,
      generation: session.generation + 1,
      activeKeys: session.activeKeys.slice(0, -1),
      trailingPreviewResolved: false,
    };
  }

  if (session.spans.length === 0) {
    return session;
  }

  const lastIdx = session.spans.length - 1;
  const lastSpan = session.spans[lastIdx];

  if (lastSpan.isPrefix) {
    if (lastSpan.separator.length > 0) {
      const newSeparator = lastSpan.separator.slice(0, -1);
      const updatedSpans = [...session.spans];
      updatedSpans[lastIdx] = {
        ...lastSpan,
        separator: newSeparator,
      };
      return {
        ...session,
        generation: session.generation + 1,
        trailingPreviewResolved: false,
        spans: updatedSpans,
      };
    }
    const prefixChars = Array.from(lastSpan.ko || lastSpan.en || "");
    const newPrefixText = prefixChars.slice(0, -1).join("");
    if (newPrefixText.length === 0) {
      return {
        ...session,
        generation: session.generation + 1,
        trailingPreviewResolved: false,
        spans: session.spans.slice(0, -1),
      };
    }
    const updatedSpans = [...session.spans];
    updatedSpans[lastIdx] = {
      ...lastSpan,
      ko: newPrefixText,
      en: newPrefixText,
    };
    return {
      ...session,
      generation: session.generation + 1,
      trailingPreviewResolved: false,
      spans: updatedSpans,
    };
  }

  if (lastSpan.separator.length > 0) {
    const newSeparator = lastSpan.separator.slice(0, -1);
    if (newSeparator.length === 0 && lastSpan.keys.length === 0) {
      return {
        ...session,
        generation: session.generation + 1,
        trailingPreviewResolved: false,
        spans: session.spans.slice(0, -1),
      };
    }
    if (newSeparator.length === 0 && lastSpan.keys.length > 0) {
      return {
        ...session,
        generation: session.generation + 1,
        trailingPreviewResolved: false,
        spans: session.spans.slice(0, -1),
        activeKeys: lastSpan.keys,
        trailingPreviewLanguage: lastSpan.language,
      };
    }
    const updatedSpans = [...session.spans];
    updatedSpans[lastIdx] = {
      ...lastSpan,
      separator: newSeparator,
    };
    return {
      ...session,
      generation: session.generation + 1,
      trailingPreviewResolved: false,
      spans: updatedSpans,
    };
  }

  const newKeys = lastSpan.keys.slice(0, -1);
  if (newKeys.length === 0) {
    return {
      ...session,
      generation: session.generation + 1,
      trailingPreviewResolved: false,
      spans: session.spans.slice(0, -1),
      activeKeys: "",
    };
  }

  return {
    ...session,
    generation: session.generation + 1,
    trailingPreviewResolved: false,
    spans: session.spans.slice(0, -1),
    activeKeys: newKeys,
    trailingPreviewLanguage: lastSpan.language,
  };
}

export function overrideSpanLanguage(
  session: AutoSpanSession,
  spanId: number,
  explicitLanguage?: AutoLanguage,
): AutoSpanSession {
  const updatedSpans = session.spans.map((span) => {
    if (span.id !== spanId) return span;
    const targetLang =
      explicitLanguage ?? (span.language === "ko" ? "en" : "ko");
    return {
      ...span,
      language: targetLang,
      isOverridden: true,
      isResolved: true,
    };
  });

  return {
    ...session,
    generation: session.generation + 1,
    spans: updatedSpans,
  };
}

export function applyDecisions(
  session: AutoSpanSession,
  requestGeneration: number,
  decisions: AutoInputDecision[],
): AutoSpanSession {
  // Invalidate stale requests
  if (requestGeneration !== session.generation) {
    return session;
  }

  const decisionMap = new Map<number, AutoLanguage>();
  for (const d of decisions) {
    decisionMap.set(d.id, d.language);
  }

  const updatedSpans = session.spans.map((span) => {
    if (span.isPrefix) return span;
    const decisionLang = decisionMap.get(span.id);
    if (!decisionLang) return span;
    // Pinned override must stay pinned against late responses
    if (span.isOverridden) return span;
    return {
      ...span,
      language: decisionLang,
      isResolved: true,
    };
  });

  return {
    ...session,
    spans: updatedSpans,
    isResolving: false,
    error: null,
  };
}

export function applyTrailingPreview(
  session: AutoSpanSession,
  requestGeneration: number,
  language: AutoLanguage,
): AutoSpanSession {
  if (requestGeneration !== session.generation) {
    return session;
  }
  return {
    ...session,
    trailingPreviewLanguage: language,
    trailingPreviewResolved: true,
  };
}

export function flushActiveSpan(
  session: AutoSpanSession,
  separator = "",
): { nextSession: AutoSpanSession; flushedSpan: AutoSpan | null } {
  if (session.activeKeys.length === 0) {
    return { nextSession: session, flushedSpan: null };
  }

  const newSpan: AutoSpan = {
    id: session.nextSpanId,
    keys: session.activeKeys,
    ko: keysToHangul(session.activeKeys),
    en: session.activeKeys,
    separator,
    language: session.trailingPreviewLanguage,
    isResolved: false,
    isOverridden: false,
  };

  return {
    nextSession: {
      ...session,
      generation: session.generation + 1,
      trailingPreviewResolved: false,
      nextSpanId: session.nextSpanId + 1,
      spans: [...session.spans, newSpan],
      activeKeys: "",
      trailingPreviewLanguage: "ko",
    },
    flushedSpan: newSpan,
  };
}

export function getSpansForResolution(session: AutoSpanSession): {
  context: string;
  spans: AutoInputSpan[];
  generation: number;
} {
  const unresolvedSpans = session.spans.filter(
    (s) => !s.isResolved && !s.isOverridden && s.keys.length > 0 && !s.isPrefix,
  );

  let context = "";
  for (const span of session.spans) {
    if (span.isResolved || span.isOverridden || span.isPrefix) {
      context += (span.language === "ko" ? span.ko : span.en) + span.separator;
    }
  }

  return {
    context: context.trim(),
    spans: unresolvedSpans.map((s) => ({
      id: s.id,
      ko: s.ko,
      en: s.en,
    })),
    generation: session.generation,
  };
}

export function renderDraftText(session: AutoSpanSession): string {
  let result = "";
  for (const span of session.spans) {
    result += (span.language === "ko" ? span.ko : span.en) + span.separator;
  }
  if (session.activeKeys.length > 0) {
    const activeText =
      session.trailingPreviewLanguage === "en"
        ? session.activeKeys
        : keysToHangul(session.activeKeys);
    result += activeText;
  }
  return result;
}

export function hasUnresolvedSpans(session: AutoSpanSession): boolean {
  return session.spans.some(
    (s) => !s.isResolved && !s.isOverridden && s.keys.length > 0 && !s.isPrefix,
  );
}

/**
 * Splits manual chunk keys into deterministic word-level spans.
 * Reuses the same segmentation rules as auto mode (split on spaces and punctuation boundaries).
 * Preserves separators (spaces, punctuation) between segments.
 */
export function splitManualChunkIntoSpans(
  keysInput: string[] | string,
): AutoSpan[] {
  let session = createInitialAutoSpanState();
  const chars = Array.isArray(keysInput) ? keysInput : Array.from(keysInput);
  for (const ch of chars) {
    session = inputKey(session, ch).nextSession;
  }
  if (session.activeKeys.length > 0) {
    session = flushActiveSpan(session, "").nextSession;
  }
  return session.spans;
}

/**
 * Renders mixed text from per-word choices: for each span, uses `ko` if language is 'ko',
 * `en` if language is 'en', with separators between.
 */
export function renderSpansText(
  spans: {
    ko: string;
    en: string;
    separator: string;
    language: AutoLanguage;
  }[],
): string {
  let result = "";
  for (const span of spans) {
    result += (span.language === "ko" ? span.ko : span.en) + span.separator;
  }
  return result;
}

/**
 * Clean rebase when transitioning from manual mode to auto mode.
 * Carries forward the current text as a literal prefix span, and carries any
 * active manual chunk keys into activeKeys.
 * Old resolved spans from previous auto sessions are discarded.
 */
export function transitionManualToAuto(
  currentText: string,
  manualChunkKeys: string[] = [],
  session?: AutoSpanSession,
): AutoSpanSession {
  const nextGen = session ? session.generation + 1 : 1;
  const spans: AutoSpan[] = [];
  let nextSpanId = 1;

  if (currentText.length > 0) {
    spans.push({
      id: nextSpanId++,
      keys: "",
      ko: currentText,
      en: currentText,
      separator: "",
      language: "ko",
      isResolved: true,
      isOverridden: true,
      isPrefix: true,
    });
  }

  let next: AutoSpanSession = {
    generation: nextGen,
    nextSpanId,
    spans,
    activeKeys: "",
    trailingPreviewLanguage: "ko",
    trailingPreviewResolved: false,
    isResolving: false,
    error: null,
  };
  for (const key of manualChunkKeys) next = inputKey(next, key).nextSession;
  return next;
}

/**
 * Keeps resolved text as a literal draft and returns unresolved physical keys
 * to the manual chunk rather than accepting an unscored language choice.
 */
export function transitionAutoToManual(session: AutoSpanSession): {
  committedText: string;
  chunkKeys: string[];
} {
  let committedText = "";
  let rawKeys = "";
  let pending = false;
  for (const span of session.spans) {
    pending ||= !span.isResolved && !span.isOverridden;
    if (pending)
      rawKeys += (span.isPrefix ? span.ko : span.keys) + span.separator;
    else
      committedText +=
        (span.language === "ko" ? span.ko : span.en) + span.separator;
  }
  return {
    committedText,
    chunkKeys: Array.from(rawKeys + session.activeKeys),
  };
}
