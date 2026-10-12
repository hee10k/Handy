import React, { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import "./Composer.css";
import {
  canRedo,
  canUndo,
  currentText as revisionCurrentText,
  EMPTY_REVISION,
  originalText as revisionOriginalText,
  revisionReducer,
} from "./revisionReducer";
import { diffTexts } from "./textDiff";
import { keysToHangul } from "./dubeolsik";
import {
  commands,
  events,
  type AutoInputDecision,
  type AutoInputSpan,
  type AutoInputState,
  type AutoLanguage,
} from "@/bindings";
import {
  applyDecisions,
  applyTrailingPreview,
  createInitialAutoSpanState,
  flushActiveSpan,
  getSpansForResolution,
  handleBackspace,
  hasUnresolvedSpans,
  inputKey,
  overrideSpanLanguage,
  renderDraftText,
  renderSpansText,
  resetAutoSpanSession,
  splitManualChunkIntoSpans,
  transitionAutoToManual,
  transitionManualToAuto,
  type AutoSpan,
  type AutoSpanSession,
} from "./autoSpanState";

// Transform mode metadata, mirroring the backend `TransformModeInfo` (ticket 03).
// We read it from `list_transform_modes` so the selector never hardcodes modes;
// raw `invoke` keeps us decoupled from the generated `src/bindings.ts`.
interface TransformModeInfo {
  id: string;
  name: string;
  description: string;
  takes_instruction: boolean;
}

// A user's saved instruction (mirrors settings `post_process_prompts`), so the
// Custom mode can pick a saved one instead of typing fresh (Spec-8).
interface SavedInstruction {
  id: string;
  name: string;
  prompt: string;
}

// Event payloads (ticket 03) — `transform-delta` / `transform-done` /
// `transform-error` are emitted by `transform::run_transform`.
interface TransformDeltaPayload {
  delta: string;
  mode: string;
}
interface TransformDonePayload {
  text: string;
  mode: string;
}
interface TransformErrorPayload {
  error: string;
  category: string;
  mode: string;
}

// A transform that was requested while the OS IME was still composing. It must
// wait for `compositionend` (which commits the final syllable into the DOM)
// before it snapshots text, so no partially-composed input is lost.
interface PendingTransform {
  mode: string;
  instruction: string;
}

// Context-aware quick-action emphasis (ticket 09 MVP): the foreground app's
// coarse category reorders the composer's assigned quick buttons and highlights
// the most relevant ones. This ONLY adjusts ordering/prominence — content is
// never read and no screenshot is taken.
interface QuickActionSlot {
  slot: number; // 1..10, maps to Cmd/Ctrl+1..0
  mode: string; // transform mode id
}

// 자동 한영 입력 (ticket 13): 백엔드는 요청한 모든 span에 대해 언어를 하나씩
// 돌려준다. 개수·중복·언어 유효성을 여기서 검증해, 잘못된 응답이 초안에 섞이지
// 않게 한다.
function validateDecisions(
  spans: AutoInputSpan[],
  decisions: AutoInputDecision[],
): AutoInputDecision[] {
  if (!Array.isArray(decisions) || decisions.length !== spans.length) {
    throw new Error("The local model did not resolve every input span.");
  }
  const remaining = new Set(spans.map((span) => span.id));
  for (const decision of decisions) {
    if (
      !decision ||
      !remaining.delete(decision.id) ||
      (decision.language !== "ko" && decision.language !== "en")
    ) {
      throw new Error("The local model returned an invalid language decision.");
    }
  }
  return decisions;
}

// 이중 언어 입력 (ticket 10): 하나의 구(chunk) = 입력된 물리 키 시퀀스.
// 한글창(keysToHangul)과 영어창(원시 키 그대로)을 동시에 렌더하고,
// 1/2 (또는 Enter 후 1/2) 로 언어를 확정해 초안에 append 한다.
interface ChunkState {
  keys: string[]; // 물리 키 시퀀스 (영어창 원본). " " = 단어 경계
  pending: boolean; // Enter 직후 1/2 선택 대기
}
const EMPTY_CHUNK: ChunkState = { keys: [], pending: false };

// 물리 키(KeyD 등) → 출력 문자. 한글/영문 자판과 무관한 원시 키만 취급
// (ticket 10): e.code 를 그대로 쓰므로 IME 상태에 영향받지 않는다.
const keyChar = (code: string, shift: boolean): string | null => {
  const m = /^Key([A-Z])$/.exec(code);
  if (!m) return null;
  return shift ? m[1] : m[1].toLowerCase();
};

// All candidates continue the current draft: local candidates replace a partial
// trailing word, while AI candidates append a phrase or sentence.
interface SentencePrediction {
  source: "prob" | "bm25" | "provider";
  text: string;
}

interface LocalContinuation {
  source: "prob" | "bm25";
  text: string;
  score: number;
}

interface ForegroundContext {
  category: AppCategory;
}

type AppCategory = "browser" | "editor" | "mail" | "other";

// Category -> transform mode ids, most relevant first. Only listed modes move
// to the front (in this order); unlisted modes keep their slot order after them.
const CATEGORY_PREFERRED: Record<AppCategory, string[]> = {
  editor: ["polish", "custom", "translate_english", "prompt_english"],
  browser: ["translate_english", "prompt_english", "polish", "custom"],
  mail: ["polish", "translate_english", "prompt_english", "custom"],
  other: [], // keep assigned slot order
};

// IME input (한글 조합) must reach the textarea untouched. Our own hotkeys
// (Enter = commit, Esc = cancel) are deliberately suppressed while the OS IME
// is composing, so those keys keep their IME meanings (confirm / cancel the
// composition) instead of firing a commit or close mid-syllable.
const Composer: React.FC = () => {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const instructionRef = useRef<HTMLInputElement>(null);
  const [text, setRenderedText] = useState("");
  const [originalText, setOriginalText] = useState(""); // pre-transform snapshot, restored on error/cancel
  const [modes, setModes] = useState<TransformModeInfo[]>([]);
  const [savedPrompts, setSavedPrompts] = useState<SavedInstruction[]>([]);
  const [mode, setMode] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  // 리비전 이력 (ticket 05): v0=원문, 각 변환 완료가 vn 을 append. undo/redo 로 이동.
  const [revisionState, dispatchRevision] = useReducer(
    revisionReducer,
    EMPTY_REVISION,
  );
  const [showDiff, setShowDiff] = useState(false);
  // 퀵 액션 (ticket 09): 사용자 할당 슬롯 (1..10 -> mode) + 포그라운드 앱 카테고리.
  const [quickSlots, setQuickSlots] = useState<QuickActionSlot[]>([]);
  const [appCategory, setAppCategory] = useState<AppCategory>("other");
  // Local dictionary continuations arrive automatically; configured models run
  // only after an explicit AI request.
  const [localPredictions, setLocalPredictions] = useState<
    SentencePrediction[]
  >([]);
  const [providerPredictions, setProviderPredictions] = useState<
    SentencePrediction[]
  >([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [hasPredictionProvider, setHasPredictionProvider] = useState(false);
  const [correction, setCorrection] = useState<string | null>(null);
  // 이중 언어 입력 (ticket 10): 현재 구의 물리 키 시퀀스 + 두 언어 파생 텍스트.
  const [chunk, setRenderedChunk] = useState<ChunkState>(EMPTY_CHUNK);
  // 자동 한영 입력 (ticket 13): 로컬 모델 기반 단어 단위 자동 언어 판별
  const [autoInputState, setAutoInputState] = useState<AutoInputState>({
    enabled: false,
    selected_model: null,
    loading: false,
    loaded_model: null,
    error: null,
  });
  const isAutoMode = Boolean(
    autoInputState.enabled && autoInputState.loaded_model,
  );
  const [autoSession, setAutoSession] = useState<AutoSpanSession>(
    createInitialAutoSpanState,
  );
  const [manualAutoPreviewSpans, setManualAutoPreviewSpans] = useState<
    AutoSpan[]
  >([]);
  const [manualPreviewError, setManualPreviewError] = useState<string | null>(
    null,
  );
  const [isDraining, setIsDraining] = useState(false);
  const manualAutoPreviewSpansRef = useRef<AutoSpan[]>([]);
  const previewKeysRef = useRef("");
  const previewDraftRef = useRef("");
  const previewModelRef = useRef<string | null>(null);
  const requestEpochRef = useRef(0);
  const commitEpochRef = useRef(0);
  const resolverInFlightRef = useRef<Promise<void> | null>(null);
  const pendingResolveRef = useRef(false);
  const drainingRef = useRef(false);
  const drainOwnerRef = useRef<number | null>(null);
  const resolverTimer = useRef<number>();
  const mountedRef = useRef(true);
  const autoSessionRef = useRef(autoSession);
  const autoInputStateRef = useRef(autoInputState);
  const chunkRef = useRef(chunk);
  const textRef = useRef(text);

  const setText = (value: React.SetStateAction<string>) => {
    const next = typeof value === "function" ? value(textRef.current) : value;
    if (next !== textRef.current && !autoInputStateRef.current.enabled) {
      requestEpochRef.current += 1;
      commitEpochRef.current += 1;
      clearManualPreview();
    }
    textRef.current = next;
    setRenderedText(next);
  };
  const clearManualPreview = () => {
    manualAutoPreviewSpansRef.current = [];
    previewKeysRef.current = "";
    setManualAutoPreviewSpans([]);
    setManualPreviewError(null);
    previewDraftRef.current = "";
    previewModelRef.current = null;
  };
  const setChunk = (value: React.SetStateAction<ChunkState>) => {
    const next = typeof value === "function" ? value(chunkRef.current) : value;
    if (next.keys !== chunkRef.current.keys) {
      requestEpochRef.current += 1;
      commitEpochRef.current += 1;
      clearManualPreview();
    }
    chunkRef.current = next;
    setRenderedChunk(next);
  };
  const publishSession = (next: AutoSpanSession, updateDraft = true) => {
    autoSessionRef.current = next;
    setAutoSession(next);
    if (updateDraft) {
      const value = renderDraftText(next);
      setText(value);
      dispatchRevision({ type: "replace-current", text: value });
    }
  };
  const invalidateRequests = () => {
    requestEpochRef.current += 1;
    commitEpochRef.current += 1;
    pendingResolveRef.current = false;
    clearTimeout(resolverTimer.current);
    drainOwnerRef.current = null;
    drainingRef.current = false;
    setIsDraining(false);
    clearManualPreview();
    // The old invoke still owns the single-flight slot until it settles.
  };
  const manualAutoPreviewText = renderSpansText(manualAutoPreviewSpans);
  const replaceDraft = (value: string) => {
    invalidateRequests();
    if (
      autoInputStateRef.current.enabled &&
      autoInputStateRef.current.loaded_model
    ) {
      publishSession(transitionManualToAuto(value, [], autoSessionRef.current));
    } else {
      setText(value);
      dispatchRevision({ type: "replace-current", text: value });
    }
  };
  const hasScoredAutoResult = Boolean(
    !isAutoMode &&
    autoInputState.loaded_model &&
    !autoInputState.loading &&
    previewKeysRef.current === chunk.keys.join("") &&
    previewDraftRef.current === text &&
    previewModelRef.current === autoInputState.loaded_model &&
    manualAutoPreviewSpans.length > 0 &&
    manualAutoPreviewSpans.every(
      (span) => span.isResolved || span.isOverridden,
    ),
  );
  const currentRawKeys = isAutoMode
    ? autoSession.activeKeys
    : chunk.keys.join("");
  const koText = useMemo(() => keysToHangul(currentRawKeys), [currentRawKeys]);
  const enText = currentRawKeys;
  const autoText = isAutoMode
    ? (autoSession.error ??
      (autoSession.trailingPreviewResolved
        ? autoSession.trailingPreviewLanguage === "en"
          ? enText
          : koText
        : t("composer.dualAutoResolving")))
    : (manualPreviewError ??
      (!autoInputState.loaded_model
        ? t("composer.dualAutoUnavailable")
        : hasScoredAutoResult
          ? manualAutoPreviewText
          : t("composer.dualAutoResolving")));
  const correctionTimer = useRef<ReturnType<typeof setTimeout>>();
  const correctionRequestRef = useRef(0);
  const localPredictionTimer = useRef<ReturnType<typeof setTimeout>>();
  const localPredictionRequestRef = useRef(0);
  const providerPredictionRequestRef = useRef(0);

  // Refs for values the mount-once event listeners must read without stale
  // closures. `streaming` guards against stray deltas after done/error/cancel;
  // `originalText` is the stable pre-transform snapshot to restore on failure;
  // `mode` marks the transform that generated the current stream.
  const streamingRef = useRef(false);
  const originalTextRef = useRef("");
  const modeRef = useRef<string | null>(null);
  const pendingTransformRef = useRef<PendingTransform | null>(null);

  // Load the transform modes from the backend (ticket 03 command).
  useEffect(() => {
    let disposed = false;
    void invoke<TransformModeInfo[]>("list_transform_modes")
      .then((m) => {
        if (!disposed) setModes(m);
      })
      .catch(() => {
        // Selector stays empty; the composer remains usable as a plain input.
      });
    void invoke<[number, string][]>("get_quick_action_slots")
      .then((slots) => {
        if (!disposed)
          setQuickSlots(slots.map(([slot, mode]) => ({ slot, mode })));
      })
      .catch(() => {
        // No assigned slots; the quick bar stays hidden.
      });
    return () => {
      disposed = true;
    };
  }, []);

  const applyAutoInputState = (next: AutoInputState) => {
    const previous = autoInputStateRef.current;
    const wasAuto = Boolean(previous.enabled && previous.loaded_model);
    const nowAuto = Boolean(next.enabled && next.loaded_model);
    if (
      previous.enabled !== next.enabled ||
      previous.selected_model !== next.selected_model ||
      previous.loaded_model !== next.loaded_model ||
      previous.loading !== next.loading
    ) {
      invalidateRequests();
      if (!wasAuto && nowAuto) {
        const rebased = transitionManualToAuto(
          textRef.current,
          chunkRef.current.keys,
          autoSessionRef.current,
        );
        setChunk(EMPTY_CHUNK);
        publishSession(rebased);
      } else if (wasAuto && !nowAuto) {
        const manual = transitionAutoToManual(autoSessionRef.current);
        setText(manual.committedText);
        dispatchRevision({
          type: "replace-current",
          text: manual.committedText,
        });
        setChunk({ keys: manual.chunkKeys, pending: false });
        publishSession(resetAutoSpanSession(autoSessionRef.current), false);
      } else {
        const current = autoSessionRef.current;
        publishSession(
          {
            ...current,
            generation: current.generation + 1,
            spans: current.spans.map((span) =>
              span.isOverridden || !span.keys
                ? span
                : { ...span, isResolved: false },
            ),
            trailingPreviewResolved: false,
            isResolving: false,
            error: null,
          },
          nowAuto,
        );
      }
    }
    autoInputStateRef.current = next;
    setAutoInputState(next);
  };
  const applyAutoInputStateRef = useRef(applyAutoInputState);
  applyAutoInputStateRef.current = applyAutoInputState;

  // Every automatic, trailing, manual-preview and final request uses one slot.
  // While it runs, only the newest live snapshot is retained.
  const resolveLatest = (): Promise<void> => {
    if (resolverInFlightRef.current) {
      pendingResolveRef.current = true;
      return resolverInFlightRef.current;
    }
    const modelState = autoInputStateRef.current;
    if (
      !mountedRef.current ||
      streamingRef.current ||
      !modelState.loaded_model ||
      modelState.loading
    ) {
      return Promise.resolve();
    }
    const automatic = Boolean(modelState.enabled && modelState.loaded_model);
    const session = autoSessionRef.current;
    const rawKeys = chunkRef.current.keys.join("");
    const draft = textRef.current;
    const epoch = requestEpochRef.current;
    const model = modelState.loaded_model;
    const selected = modelState.selected_model;
    const manualSpans = automatic ? [] : splitManualChunkIntoSpans(rawKeys);
    const resolution = getSpansForResolution(session);
    const activeId = session.nextSpanId;
    const spans: AutoInputSpan[] = automatic
      ? [
          ...resolution.spans,
          ...(session.activeKeys && !session.trailingPreviewResolved
            ? [
                {
                  id: activeId,
                  ko: keysToHangul(session.activeKeys),
                  en: session.activeKeys,
                },
              ]
            : []),
        ]
      : manualSpans
          .filter((span) => span.keys)
          .map(({ id, ko, en }) => ({ id, ko, en }));
    if (!automatic && !rawKeys) return Promise.resolve();
    const isCurrent = () => {
      const state = autoInputStateRef.current;
      return (
        mountedRef.current &&
        epoch === requestEpochRef.current &&
        state.loaded_model === model &&
        state.selected_model === selected &&
        !state.loading &&
        Boolean(state.enabled && state.loaded_model) === automatic &&
        (automatic
          ? autoSessionRef.current.generation === session.generation
          : chunkRef.current.keys.join("") === rawKeys &&
            textRef.current === draft)
      );
    };
    if (!spans.length) {
      if (!automatic) {
        manualAutoPreviewSpansRef.current = manualSpans;
        previewKeysRef.current = rawKeys;
        setManualAutoPreviewSpans(manualSpans);
        previewDraftRef.current = draft;
        previewModelRef.current = model;
      }
      return Promise.resolve();
    }
    pendingResolveRef.current = false;
    if (automatic)
      publishSession({ ...session, isResolving: true, error: null }, false);
    else setManualPreviewError(null);
    const request: Promise<void> = commands
      .resolveAutoInput(automatic ? resolution.context : draft, spans)
      .then((result) => {
        if (result.status === "error") throw new Error(result.error);
        const decisions = validateDecisions(spans, result.data);
        if (!isCurrent()) return;
        if (automatic) {
          let next = applyDecisions(
            autoSessionRef.current,
            session.generation,
            decisions,
          );
          const trailing = decisions.find(
            (decision) => decision.id === activeId,
          );
          if (session.activeKeys && trailing) {
            next = applyTrailingPreview(
              next,
              session.generation,
              trailing.language,
            );
          }
          publishSession(next);
        } else {
          const resolved = manualSpans.map((span) => {
            const decision = decisions.find((item) => item.id === span.id);
            return decision
              ? { ...span, language: decision.language, isResolved: true }
              : span;
          });
          manualAutoPreviewSpansRef.current = resolved;
          previewKeysRef.current = rawKeys;
          setManualAutoPreviewSpans(resolved);
          previewDraftRef.current = draft;
          previewModelRef.current = model;
        }
      })
      .catch((err) => {
        if (!isCurrent()) return;
        const message = `${t("composer.autoResolveFailed")}: ${String(err)}`;
        if (automatic)
          publishSession(
            {
              ...autoSessionRef.current,
              isResolving: false,
              error: message,
            },
            false,
          );
        else setManualPreviewError(message);
      })
      .finally(() => {
        if (resolverInFlightRef.current !== request) return;
        resolverInFlightRef.current = null;
        if (!mountedRef.current) return;
        if (automatic && autoSessionRef.current.isResolving) {
          publishSession(
            { ...autoSessionRef.current, isResolving: false },
            false,
          );
        }
        if (pendingResolveRef.current && !drainingRef.current) {
          pendingResolveRef.current = false;
          void resolverRef.current();
        }
      });
    resolverInFlightRef.current = request;
    return request;
  };
  const resolverRef = useRef(resolveLatest);
  resolverRef.current = resolveLatest;

  useEffect(() => {
    mountedRef.current = true;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let stateVersion = 0;
    const queryState = () => {
      const initialVersion = stateVersion;
      void commands
        .getAutoInputState()
        .then((result) => {
          if (disposed || stateVersion !== initialVersion) return;
          if (result.status === "error") throw new Error(result.error);
          applyAutoInputStateRef.current(result.data);
        })
        .catch((err) => {
          if (!disposed) setError(String(err));
        });
    };
    void events.autoInputModelStatePayload
      .listen(({ payload }) => {
        if (disposed) return;
        stateVersion += 1;
        applyAutoInputStateRef.current(payload);
      })
      .then((fn) => {
        if (disposed) fn();
        else {
          unlisten = fn;
          queryState();
        }
      })
      .catch((err) => {
        if (!disposed) {
          setError(String(err));
          queryState();
        }
      });
    return () => {
      disposed = true;
      mountedRef.current = false;
      requestEpochRef.current += 1;
      commitEpochRef.current += 1;
      pendingResolveRef.current = false;
      clearTimeout(resolverTimer.current);
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    clearTimeout(resolverTimer.current);
    if (streaming || autoInputState.loading || !autoInputState.loaded_model)
      return;
    if (
      isAutoMode
        ? !hasUnresolvedSpans(autoSession) &&
          (!autoSession.activeKeys || autoSession.trailingPreviewResolved)
        : !chunk.keys.length
    )
      return;
    resolverTimer.current = window.setTimeout(() => {
      if (!drainingRef.current) void resolverRef.current();
    }, 150);
    return () => clearTimeout(resolverTimer.current);
  }, [
    isAutoMode,
    autoSession.generation,
    chunk.keys,
    text,
    autoInputState.loaded_model,
    autoInputState.loading,
    streaming,
  ]);

  const handleSpanOverride = (spanId: number) => {
    commitEpochRef.current += 1;
    publishSession(overrideSpanLanguage(autoSessionRef.current, spanId));
    textareaRef.current?.focus();
  };

  const handleManualWordToggle = (spanId: number) => {
    const spans = manualAutoPreviewSpansRef.current.map((span) => {
      if (span.id !== spanId) return span;
      const language: AutoLanguage = span.language === "ko" ? "en" : "ko";
      return { ...span, language, isOverridden: true, isResolved: true };
    });
    manualAutoPreviewSpansRef.current = spans;
    setManualAutoPreviewSpans(spans);
    textareaRef.current?.focus();
  };

  const drainAndResolveAutoSpans = async (): Promise<string | null> => {
    if (drainingRef.current) return null;
    drainingRef.current = true;
    setIsDraining(true);
    clearTimeout(resolverTimer.current);
    pendingResolveRef.current = false;
    const epoch = ++commitEpochRef.current;
    drainOwnerRef.current = epoch;
    const requestEpoch = requestEpochRef.current;
    const model = autoInputStateRef.current.loaded_model;
    publishSession(flushActiveSpan(autoSessionRef.current).nextSession);
    const generation = autoSessionRef.current.generation;
    const isCurrent = () =>
      mountedRef.current &&
      commitEpochRef.current === epoch &&
      requestEpochRef.current === requestEpoch &&
      autoSessionRef.current.generation === generation &&
      autoInputStateRef.current.loaded_model === model &&
      autoInputStateRef.current.enabled &&
      !autoInputStateRef.current.loading;
    try {
      if (resolverInFlightRef.current) await resolverInFlightRef.current;
      if (!isCurrent()) return null;
      if (hasUnresolvedSpans(autoSessionRef.current))
        await resolverRef.current();
      if (!isCurrent()) return null;
      if (
        hasUnresolvedSpans(autoSessionRef.current) ||
        autoSessionRef.current.error
      ) {
        return null;
      }
      const value = renderDraftText(autoSessionRef.current);
      setText(value);
      dispatchRevision({ type: "replace-current", text: value });
      return value;
    } finally {
      if (drainOwnerRef.current === epoch) {
        drainOwnerRef.current = null;
        drainingRef.current = false;
        if (mountedRef.current) setIsDraining(false);
        if (pendingResolveRef.current && mountedRef.current) {
          pendingResolveRef.current = false;
          void resolverRef.current();
        }
      }
    }
  };

  // Load saved instructions and whether the configured provider can generate
  // optional AI rewrites. Local candidates never depend on this setting.
  useEffect(() => {
    let disposed = false;
    void invoke<{
      post_process_prompts?: SavedInstruction[];
      post_process_provider_id?: string;
      post_process_models?: Record<string, string>;
    }>("get_app_settings")
      .then((settings) => {
        if (disposed) return;
        setSavedPrompts(settings.post_process_prompts ?? []);
        const providerId = settings.post_process_provider_id;
        setHasPredictionProvider(
          Boolean(
            providerId && settings.post_process_models?.[providerId]?.trim(),
          ),
        );
      })
      .catch(() => {
        if (!disposed) setHasPredictionProvider(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Local probability/BM25 continuations are the default: no API, no network,
  // and requested only after a short typing pause.
  useEffect(() => {
    providerPredictionRequestRef.current += 1;
    setProviderPredictions([]);
    setAiLoading(false);
    const requestId = ++localPredictionRequestRef.current;
    clearTimeout(localPredictionTimer.current);
    setLocalPredictions([]);
    if (streaming || isComposing || !text.trim()) return;
    localPredictionTimer.current = setTimeout(() => {
      void invoke<LocalContinuation[]>("get_continuation_suggestions", { text })
        .then((suggestions) => {
          if (localPredictionRequestRef.current !== requestId) return;
          const probability = suggestions.find(
            (item) => item.source === "prob",
          );
          const bm25 = suggestions.find((item) => item.source === "bm25");
          setLocalPredictions(
            [probability, bm25]
              .filter((item): item is LocalContinuation => Boolean(item))
              .map(({ source, text }) => ({ source, text })),
          );
        })
        .catch(() => {
          if (localPredictionRequestRef.current === requestId)
            setLocalPredictions([]);
        });
    }, 150);
    return () => clearTimeout(localPredictionTimer.current);
  }, [text, streaming, isComposing]);

  // A local spelling pass exposes a reversible correction without changing the
  // draft until the user explicitly selects it.
  useEffect(() => {
    const requestId = ++correctionRequestRef.current;
    clearTimeout(correctionTimer.current);
    setCorrection(null);
    if (streaming || isComposing || !text.trim()) return;
    correctionTimer.current = setTimeout(() => {
      void invoke<string | null>("correct_text", { text })
        .then((value) => {
          if (correctionRequestRef.current === requestId) setCorrection(value);
        })
        .catch(() => {
          if (correctionRequestRef.current === requestId) setCorrection(null);
        });
    }, 450);
    return () => clearTimeout(correctionTimer.current);
  }, [text, streaming, isComposing]);

  const requestProviderPredictions = () => {
    const requestId = ++providerPredictionRequestRef.current;
    const draft = text.trim();
    if (!draft || !hasPredictionProvider || streaming || isComposing) return;
    setAiLoading(true);
    setProviderPredictions([]);
    void invoke<string[]>("suggest_llm_continuations", {
      text: draft,
      count: 3,
    })
      .then((sentences) => {
        if (providerPredictionRequestRef.current !== requestId) return;
        const seen = new Set<string>();
        setProviderPredictions(
          sentences
            .filter((sentence) =>
              seen.has(sentence) ? false : (seen.add(sentence), true),
            )
            .map((text) => ({ source: "provider", text })),
        );
      })
      .catch(() => {
        if (providerPredictionRequestRef.current === requestId)
          setProviderPredictions([]);
      })
      .finally(() => {
        if (providerPredictionRequestRef.current === requestId)
          setAiLoading(false);
      });
  };

  // Voice-while-composing: when a transcription completes while this composer is
  // the focused foreground window, the backend delivers it here (rather than an
  // OS clipboard paste) so it lands deterministically in the draft. Appended to
  // the textarea and mirrored into the revision stack (ignore mid-transform).
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<string>("composer-voice-input", (event) => {
      if (disposed || streamingRef.current) return;
      const incoming = event.payload;
      if (!incoming) return;
      if (
        autoInputStateRef.current.enabled &&
        autoInputStateRef.current.loaded_model
      ) {
        invalidateRequests();
        const current = flushActiveSpan(autoSessionRef.current).nextSession;
        const draft = renderDraftText(current);
        const literal = (draft && !draft.endsWith(" ") ? " " : "") + incoming;
        publishSession({
          ...current,
          generation: current.generation + 1,
          nextSpanId: current.nextSpanId + 1,
          spans: [
            ...current.spans,
            {
              id: current.nextSpanId,
              keys: "",
              ko: literal,
              en: literal,
              separator: "",
              language: "ko",
              isResolved: true,
              isOverridden: true,
              isPrefix: true,
            },
          ],
        });
      } else {
        const draft = textRef.current;
        replaceDraft(
          (draft && !draft.endsWith(" ") ? draft + " " : draft) + incoming,
        );
      }
      textareaRef.current?.focus();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Mount-once listeners for the backend streaming events and the open signal.
  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const subscribe = (subscription: Promise<UnlistenFn>) => {
      void subscription
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch((err) => {
          if (!disposed) setError(String(err));
        });
    };
    [
      listen<TransformDeltaPayload>("transform-delta", (e) => {
        if (disposed || !streamingRef.current) return;
        setText((t) => t + e.payload.delta);
      }),
      listen<TransformDonePayload>("transform-done", (e) => {
        if (
          disposed ||
          !streamingRef.current ||
          e.payload.mode !== modeRef.current
        )
          return;
        streamingRef.current = false;
        setStreaming(false);
        setError(null);
        replaceDraft(e.payload.text);
        dispatchRevision({ type: "append", text: e.payload.text });
      }),
      listen<TransformErrorPayload>("transform-error", (e) => {
        if (disposed || e.payload.mode !== modeRef.current) return;
        streamingRef.current = false;
        setStreaming(false);
        replaceDraft(originalTextRef.current);
        setError(e.payload.error);
      }),
      listen("composer-open", () => {
        if (disposed) return;
        // Fresh draft: cancel any in-flight transform, clear all state, focus.
        void invoke("cancel_transform");
        streamingRef.current = false;
        pendingTransformRef.current = null;
        modeRef.current = null;
        setText("");
        setOriginalText("");
        setMode(null);
        setInstruction("");
        setStreaming(false);
        setError(null);
        setIsComposing(false);
        dispatchRevision({ type: "reset" });
        setShowDiff(false);
        setLocalPredictions([]);
        setProviderPredictions([]);
        setChunk(EMPTY_CHUNK);
        invalidateRequests();
        publishSession(resetAutoSpanSession(autoSessionRef.current), false);
        localPredictionRequestRef.current += 1;
        correctionRequestRef.current += 1;
        providerPredictionRequestRef.current += 1;
        clearTimeout(localPredictionTimer.current);
        clearTimeout(correctionTimer.current);
        // Re-classify the foreground app each time the composer opens so the
        // quick buttons reflect the current context (ticket 09).
        void invoke<string>("get_foreground_app_category")
          .then((c) => {
            if (
              !disposed &&
              (c === "browser" || c === "editor" || c === "mail")
            )
              setAppCategory(c);
            else setAppCategory("other");
          })
          .catch(() => setAppCategory("other"));
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      }),
    ].forEach(subscribe);
    return () => {
      disposed = true;
      for (const u of unlisteners) u();
    };
  }, []);

  // Start a transform reading the *current* text directly from the textarea
  // DOM element so any final IME-committed syllable is included. Snapshots the
  // original text (to restore on failure/cancel) and clears the textarea to
  // stream the fresh result into it.
  const transformNow = (selectedMode: string, instr: string) => {
    void (async () => {
      let value = textareaRef.current?.value ?? text;
      if (isAutoMode) {
        const resolved = await drainAndResolveAutoSpans();
        if (resolved === null) {
          return;
        }
        value = resolved;
      }
      if (!value || value.trim().length === 0) return; // empty/whitespace input is a no-op
      const instructionArg = instr.trim();
      if (selectedMode === "custom" && instructionArg.length === 0) return; // needs an instruction
      originalTextRef.current = value;
      setOriginalText(value);
      modeRef.current = selectedMode;
      streamingRef.current = true;
      invalidateRequests();
      setStreaming(true);
      setError(null);
      setMode(selectedMode);
      setText(""); // begin streaming the result fresh
      const payload: { mode: string; text: string; instruction?: string } = {
        mode: selectedMode,
        text: value,
      };
      if (instructionArg.length > 0) payload.instruction = instructionArg;
      void invoke("run_transform", payload).catch((err) => {
        // Mid-stream errors already arrive as `transform-error` (handled above,
        // which clears streamingRef). This catches pre-flight failures (no
        // provider / model / key) that only reject the invoke.
        if (!streamingRef.current) return;
        streamingRef.current = false;
        setStreaming(false);
        replaceDraft(originalTextRef.current);
        setError(String(err));
      });
    })();
  };

  // Request a transform. If the IME is mid-composition, defer until
  // `compositionend` so no syllable is dropped; otherwise run immediately.
  const requestTransform = (selectedMode: string, instr: string) => {
    if (isComposing) {
      pendingTransformRef.current = { mode: selectedMode, instruction: instr };
      return;
    }
    transformNow(selectedMode, instr);
  };

  const handleModeClick = (m: TransformModeInfo) => {
    if (streaming) return; // selector is disabled mid-stream; defensive
    if (m.takes_instruction) {
      // Entering Custom: reveal the instruction input, transform on Enter.
      setMode(m.id);
      requestAnimationFrame(() => instructionRef.current?.focus());
      return;
    }
    requestTransform(m.id, "");
  };

  // Run a transform from a quick button or Cmd/Ctrl+shortcut (ticket 09).
  // Instruction-taking modes open the instruction input instead of running.
  const runQuickAction = (modeId: string) => {
    if (streaming) return;
    const m = modes.find((x) => x.id === modeId);
    if (!m) return;
    if (m.takes_instruction) {
      setMode(m.id);
      requestAnimationFrame(() => instructionRef.current?.focus());
      return;
    }
    requestTransform(modeId, "");
  };

  // Assigned quick slots, reordered so the current category's preferred modes
  // surface first (highlighted); unlisted modes keep slot order afterwards.
  const quickButtons = useMemo(() => {
    if (quickSlots.length === 0) return [];
    const preferred = CATEGORY_PREFERRED[appCategory] ?? [];
    if (appCategory === "other" || preferred.length === 0) return quickSlots;
    const rank = new Map(preferred.map((m, i) => [m, i]));
    const fallback = preferred.length;
    return [...quickSlots].sort((a, b) => {
      const ra = rank.get(a.mode) ?? fallback;
      const rb = rank.get(b.mode) ?? fallback;
      return ra - rb || a.slot - b.slot;
    });
  }, [quickSlots, appCategory]);

  // The single most relevant action for the current category (highlighted).
  const suggestedMode = useMemo(() => {
    const preferred = CATEGORY_PREFERRED[appCategory] ?? [];
    if (appCategory === "other" || preferred.length === 0) return null;
    return preferred.find((m) => quickSlots.some((s) => s.mode === m)) ?? null;
  }, [quickSlots, appCategory]);

  // A local candidate completes the trailing word; an AI candidate always
  // appends to the current draft exactly as returned by the provider.
  const applyPrediction = (prediction: SentencePrediction) => {
    const next =
      prediction.source === "provider"
        ? `${text}${text.endsWith(" ") || text.endsWith("\n") ? "" : " "}${prediction.text} `
        : text.endsWith(" ") || text.endsWith("\n")
          ? `${text}${prediction.text} `
          : `${text.replace(/\S+$/, "")}${prediction.text} `;
    replaceDraft(next);
    setLocalPredictions([]);
    setProviderPredictions([]);
    textareaRef.current?.focus();
  };

  const applyCorrection = () => {
    if (!correction) return;
    replaceDraft(correction);
    setCorrection(null);
    textareaRef.current?.focus();
  };

  // 이중 언어 입력 (ticket 10): 선택된 언어로 현재 구를 초안에 append 하고
  // 리비전을 replace-current 로 갱신한다 (기존 applyPrediction/applyCorrection 와 동일 정책).
  const commitChunk = (lang: "ko" | "en") => {
    invalidateRequests();
    const picked = lang === "ko" ? koText : enText;
    const sep = text && !text.endsWith(" ") ? " " : "";
    const next = `${text}${sep}${picked} `;
    setChunk(EMPTY_CHUNK);
    setText(next);
    setLocalPredictions([]);
    setProviderPredictions([]);
    dispatchRevision({ type: "replace-current", text: next });
    textareaRef.current?.focus();
  };

  const selectManualAutoResult = () => {
    const state = autoInputStateRef.current;
    const spans = manualAutoPreviewSpansRef.current;
    if (
      state.enabled ||
      !state.loaded_model ||
      state.loading ||
      previewKeysRef.current !== chunkRef.current.keys.join("") ||
      previewDraftRef.current !== textRef.current ||
      previewModelRef.current !== state.loaded_model ||
      !spans.length ||
      spans.some((span) => !span.isResolved && !span.isOverridden)
    )
      return;
    const picked = renderSpansText(spans);
    const draft = textRef.current;
    const separator =
      draft && !draft.endsWith(" ") && !draft.endsWith("\n") ? " " : "";
    const next = draft + separator + picked;
    invalidateRequests();
    setChunk(EMPTY_CHUNK);
    setText(next);
    dispatchRevision({ type: "replace-current", text: next });
    setLocalPredictions([]);
    setProviderPredictions([]);
    textareaRef.current?.focus();
  };

  const handleInstructionKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.nativeEvent.isComposing) return; // let the IME finalize the instruction
    // Quick actions also work while the instruction input is focused.
    if ((e.metaKey || e.ctrlKey) && e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      const slotIdx = e.key === "0" ? 10 : Number(e.key);
      const assigned = quickSlots.find((s) => s.slot === slotIdx);
      if (assigned) runQuickAction(assigned.mode);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      requestTransform("custom", instruction);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (streaming) cancelInFlight();
      else cancel();
    }
  };

  const finalizeComposition = () => {
    setIsComposing(false);
    // Pull the final (IME-committed) value straight from the DOM so the last
    // composed syllable is never dropped, and mirror it into the revision draft
    // so v0/current stays in sync with what the user actually typed.
    const el = textareaRef.current;
    if (el) {
      setText(el.value);
      dispatchRevision({ type: "replace-current", text: el.value });
    }
    const pending = pendingTransformRef.current;
    if (pending) {
      pendingTransformRef.current = null;
      transformNow(pending.mode, pending.instruction);
    }
  };

  const commit = () => {
    void (async () => {
      let value = text;
      if (isAutoMode) {
        const resolved = await drainAndResolveAutoSpans();
        if (resolved === null) {
          return;
        }
        value = resolved;
      }
      // Empty text is ignored (backend enforces the same guard).
      if (!value || value.trim().length === 0) {
        void invoke("cancel_composer");
        return;
      }
      // Reuse the ticket-02 commit path: paste current textarea text at the
      // previously-focused app's cursor, then restore the clipboard.
      invalidateRequests();
      void invoke("commit_composer", { text: value }).catch((err) =>
        setError(String(err)),
      );
    })();
  };

  const cancelInFlight = () => {
    // Cancel only this transform request; keep the composer open and restore
    // the pre-transform text so nothing is pasted and nothing is lost.
    void invoke("cancel_transform");
    streamingRef.current = false;
    pendingTransformRef.current = null;
    setStreaming(false);
    setError(null);
    replaceDraft(originalTextRef.current);
  };

  const cancel = () => {
    invalidateRequests();
    void invoke("cancel_composer");
  };

  const openSettings = () => {
    // Leave the compositing session before showing settings: the composer is
    // an always-on-top window, and switching the app to Regular activation for
    // the settings window lets macOS dismiss/interleave the floating composer
    // next to it (reported as both closing together). Closing the composer
    // first makes the transition deterministic: composer down, settings up.
    invalidateRequests();
    void (async () => {
      await invoke("cancel_composer");
      await invoke("show_main_window_command");
    })();
  };

  // Undo/redo: move the revision pointer and restore the target revision's text
  // into the textarea. Reading `revisionState` from the current render keeps the
  // target index correct without stale closures.
  const undo = () => {
    if (!canUndo(revisionState)) return;
    dispatchRevision({ type: "undo" });
    invalidateRequests();
    const value = revisionState.revisions[revisionState.index - 1];
    if (isAutoMode)
      publishSession(
        transitionManualToAuto(value, [], autoSessionRef.current),
        false,
      );
    setText(value);
  };
  const redo = () => {
    if (!canRedo(revisionState)) return;
    dispatchRevision({ type: "redo" });
    invalidateRequests();
    const value = revisionState.revisions[revisionState.index + 1];
    if (isAutoMode)
      publishSession(
        transitionManualToAuto(value, [], autoSessionRef.current),
        false,
      );
    setText(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the IME composes, Enter finalizes the current syllable and Esc
    // cancels the in-progress composition — never treat those as commit/close.
    if (e.nativeEvent.isComposing) {
      return;
    }
    // Settings (Cmd+, / Ctrl+,) opens the main settings window from here.
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      openSettings();
      return;
    }
    // Quick actions (ticket 09): Cmd/Ctrl+1..0 triggers the assigned slot.
    if ((e.metaKey || e.ctrlKey) && e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      const slotIdx = e.key === "0" ? 10 : Number(e.key);
      const assigned = quickSlots.find((s) => s.slot === slotIdx);
      if (assigned) runQuickAction(assigned.mode);
      return;
    }
    if (
      (e.metaKey || e.ctrlKey) &&
      e.shiftKey &&
      (e.key === "p" || e.key === "P")
    ) {
      e.preventDefault();
      requestProviderPredictions();
      return;
    }
    // Cmd/Ctrl+Enter: 최종 커밋 (자동 모드 및 수동 모드 공통)
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!streaming) commit();
      return;
    }
    if (streaming && e.key !== "Escape") {
      e.preventDefault();
      return;
    }

    if (isAutoMode) {
      // === 자동 한영 입력 모드 (ticket 13) ===
      const handleAutoInputKey = (key: string) => {
        commitEpochRef.current += 1;
        const { nextSession, boundaryFlushed } = inputKey(
          autoSessionRef.current,
          key,
        );
        publishSession({ ...nextSession, error: null });
        if (resolverInFlightRef.current) pendingResolveRef.current = true;
        if (boundaryFlushed && !drainingRef.current) void resolverRef.current();
      };

      const letter = keyChar(e.nativeEvent.code, e.shiftKey);
      if (letter && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        handleAutoInputKey(letter);
        return;
      }

      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        handleAutoInputKey(" ");
        return;
      }

      // Enter: 자동 모드에서는 적절한 줄바꿈 (line boundary) 생성
      if (e.key === "Enter" && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        handleAutoInputKey("\n");
        return;
      }

      // 1/2: 자동 모드에서는 일반 숫자 리터럴로 입력됨 (선택 키 아님)
      if (
        (e.key === "1" || e.key === "2") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        handleAutoInputKey(e.key);
        return;
      }

      // ⌥(macOS)/Alt(Windows)+1/2: 리터럴 '1'/'2'
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "1" || e.key === "2")
      ) {
        e.preventDefault();
        handleAutoInputKey(e.key);
        return;
      }

      // 3-0 및 기타 문자/기호/문장부호
      if (
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key !== " "
      ) {
        e.preventDefault();
        handleAutoInputKey(e.key);
        return;
      }

      // Backspace: 활성 키 또는 직전 span 롤백
      if (
        e.key === "Backspace" &&
        (autoSession.activeKeys.length > 0 || autoSession.spans.length > 0)
      ) {
        e.preventDefault();
        commitEpochRef.current += 1;
        publishSession({
          ...handleBackspace(autoSessionRef.current),
          error: null,
        });
        if (resolverInFlightRef.current) pendingResolveRef.current = true;
        return;
      }

      // Esc: 활성 세션 폐기
      if (
        e.key === "Escape" &&
        (autoSession.activeKeys.length > 0 || autoSession.spans.length > 0)
      ) {
        e.preventDefault();
        invalidateRequests();
        publishSession(resetAutoSpanSession(autoSessionRef.current));
        return;
      }
    } else {
      // === 수동 이중 언어 입력 (ticket 10 기존 로직 유지) ===
      const letter = keyChar(e.nativeEvent.code, e.shiftKey);
      if (letter && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setChunk((c) => ({ keys: [...c.keys, letter], pending: false }));
        return;
      }
      // Space: 단어 경계 (두 창 모두 공백 반영)
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setChunk((c) => ({ keys: [...c.keys, " "], pending: false }));
        return;
      }
      // Backspace: 구가 비어있지 않으면 양 창을 동시에 롤백
      if (e.key === "Backspace" && chunk.keys.length > 0) {
        e.preventDefault();
        setChunk((c) => ({ keys: c.keys.slice(0, -1), pending: false }));
        return;
      }
      // Enter: 구가 있으면 1/2 선택을 강제 (pending). 빈 구는 no-op.
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        if (chunk.keys.length > 0) setChunk((c) => ({ ...c, pending: true }));
        return;
      }
      // 1/2: 구 확정 → 초안 append. 구가 없으면 1/2 는 일반 문자(리터럴).
      if (
        chunk.keys.length > 0 &&
        (e.key === "1" || e.key === "2") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault();
        commitChunk(e.key === "1" ? "ko" : "en");
        return;
      }
      // ⌥(macOS)/Alt(Windows)+1/2: 리터럴 '1'/'2' 입력 (구가 없을 때에도 동작)
      if (
        e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "1" || e.key === "2")
      ) {
        e.preventDefault();
        setChunk((c) => ({ keys: [...c.keys, e.key], pending: false }));
        return;
      }
      // 3-0 및 기타 문자/기호: 영어창에 리터럴 반영
      if (
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        e.key !== " "
      ) {
        e.preventDefault();
        setChunk((c) => ({ keys: [...c.keys, e.key], pending: false }));
        return;
      }
      // Esc: 구가 있으면 폐기, 없으면 기존 동작(예측 닫기/취소/컴포저 닫기)
      if (e.key === "Escape" && chunk.keys.length > 0) {
        e.preventDefault();
        setChunk(EMPTY_CHUNK);
        return;
      }
    }
    // Undo/redo across revisions (ticket 05). Meta = ⌘ on macOS, Ctrl elsewhere.
    if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (streaming) return; // never navigate mid-stream
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      if (streaming) return;
      redo();
      return;
    }
    if (e.key === "Tab") {
      const first = [...localPredictions, ...providerPredictions][0];
      if (first && !streaming && !aiLoading) {
        e.preventDefault();
        applyPrediction(first);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (localPredictions.length > 0 || providerPredictions.length > 0) {
        setLocalPredictions([]);
        setProviderPredictions([]);
        return;
      }
      if (streaming)
        cancelInFlight(); // Esc cancels only the in-flight request
      else cancel(); // nothing streaming: close the composer
    }
  };

  const statusClass = [
    "composer__status",
    streaming ? "composer__status--streaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Diff 세그먼트 (원문 v0 ↔ 현재 리비전): 리비전/토글이 바뀔 때만 재계산.
  const diffSegments = useMemo(
    () =>
      diffTexts(
        revisionOriginalText(revisionState),
        revisionCurrentText(revisionState),
      ),
    [revisionState, showDiff],
  );

  return (
    <div
      className={`composer ${isComposing ? "composer--composing" : ""} ${streaming ? "composer--streaming" : ""}`}
      onClick={() => textareaRef.current?.focus()}
    >
      <div className="composer__glow" aria-hidden="true" />
      <div className="composer__topbar">
        <button
          type="button"
          className="composer__iconbtn"
          aria-label={t("composer.openSettingsTitle")}
          title={t("composer.openSettingsTitle")}
          onClick={(e) => {
            e.stopPropagation();
            openSettings();
          }}
        >
          {String.fromCharCode(0x2699)}
        </button>
        <button
          type="button"
          className="composer__iconbtn"
          aria-label={t("composer.closeTitle")}
          title={t("composer.closeTitle")}
          onClick={(e) => {
            e.stopPropagation();
            cancel();
          }}
        >
          {String.fromCharCode(0x2715)}
        </button>
      </div>
      {quickButtons.length > 0 && (
        <div
          className="composer__quick"
          role="group"
          aria-label={t("composer.quickAriaLabel")}
        >
          {quickButtons.map((qs) => {
            const meta = modes.find((m) => m.id === qs.mode);
            if (!meta) return null; // mode no longer available; skip the slot
            const isSuggested = suggestedMode === qs.mode;
            return (
              <button
                key={qs.slot}
                type="button"
                className={`composer__quickbtn ${
                  isSuggested ? "composer__quickbtn--suggested" : ""
                }`}
                title={meta.description}
                disabled={streaming}
                onClick={() => runQuickAction(qs.mode)}
              >
                <span className="composer__quick-key">
                  {qs.slot === 10 ? "0" : qs.slot}
                </span>
                <span className="composer__quick-label">{meta.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {modes.length > 0 && (
        <div
          className="composer__modes"
          role="group"
          aria-label={t("composer.modesAriaLabel")}
        >
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`composer__mode ${mode === m.id ? "composer__mode--active" : ""}`}
              title={m.description}
              disabled={streaming}
              onClick={() => handleModeClick(m)}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}
      {mode === "custom" && (
        <>
          {savedPrompts.length > 0 && (
            <select
              className="composer__saved-instruction"
              value=""
              onChange={(e) => {
                if (e.target.value) setInstruction(e.target.value);
              }}
              aria-label={t("composer.savedInstructionLabel")}
            >
              <option value="">
                {t("composer.savedInstructionPlaceholder")}
              </option>
              {savedPrompts.map((p) => (
                <option key={p.id} value={p.prompt}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <input
            ref={instructionRef}
            className="composer__instruction"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleInstructionKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={finalizeComposition}
            placeholder={t("composer.instructionPlaceholder")}
            spellCheck={false}
          />
        </>
      )}
      <textarea
        ref={textareaRef}
        className="composer__input"
        value={text}
        onChange={(e) => {
          if (streaming) return;
          const next = e.target.value;
          setProviderPredictions([]);
          replaceDraft(next);
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={finalizeComposition}
        onBeforeInput={(e) => {
          // 이중 언어 입력 (ticket 10): textarea 는 초안 표시 전용. OS/IME 가
          // keydown preventDefault 만으로는 조합 텍스트를 textarea 에 주입하므로
          // beforeinput 레벨에서도 삽입을 차단한다 — 타이핑은 chunk 키 시퀀스로만
          // 반영되고 1/2 확정 시 초안에 들어간다.
          const ie = e as unknown as InputEvent;
          if (
            ie.inputType === "insertCompositionText" ||
            ie.inputType === "insertText" ||
            ie.inputType === "insertLineBreak"
          ) {
            e.preventDefault();
          }
        }}
        placeholder={t("composer.inputPlaceholder")}
        autoFocus
        // readOnly: 초안 표시 전용. 타이핑은 keydown 캡처(chunk)로만 처리하고,
        // macOS IME 가 textarea 에 조합을 주입하지 못하게 막는 가장 확실한 수단.
        // 커서/조합 표시는 이중 해석 창(composer__dual)이 대신한다.
        readOnly
        spellCheck={false}
      />
      {currentRawKeys.length > 0 && (
        <div
          className="composer__dual"
          role="region"
          aria-label={t("composer.dualAria")}
        >
          <div className="composer__dual-row">
            <span className="composer__dual-src">{t("composer.dualKo")}</span>
            <span className="composer__dual-text">{koText}</span>
          </div>
          <div className="composer__dual-row">
            <span className="composer__dual-src">{t("composer.dualEn")}</span>
            <span className="composer__dual-text">{enText}</span>
          </div>
          <div className="composer__dual-row composer__dual-row--auto">
            <span className="composer__dual-src composer__dual-src--auto">
              {t("composer.dualAuto")}
            </span>
            <span
              className={`composer__dual-text ${
                !hasScoredAutoResult && !autoSession.trailingPreviewResolved
                  ? "composer__dual-text--dim"
                  : ""
              }`}
            >
              {hasScoredAutoResult
                ? manualAutoPreviewSpans.map((span) => {
                    const displayText =
                      span.language === "ko" ? span.ko : span.en;
                    return (
                      <React.Fragment key={span.id}>
                        {span.keys.length > 0 ? (
                          <button
                            type="button"
                            className={`composer__dual-word ${
                              span.isOverridden
                                ? "composer__dual-word--overridden"
                                : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleManualWordToggle(span.id);
                            }}
                            title={t("composer.spanOverrideTitle")}
                          >
                            {displayText}
                          </button>
                        ) : (
                          displayText
                        )}
                        {span.separator}
                      </React.Fragment>
                    );
                  })
                : autoText}
            </span>
            {!isAutoMode && (
              <button
                type="button"
                className="composer__dual-select-auto"
                disabled={!hasScoredAutoResult || streaming}
                onClick={(event) => {
                  event.stopPropagation();
                  selectManualAutoResult();
                }}
              >
                {t("composer.selectAuto")}
              </button>
            )}
          </div>
          {!isAutoMode && chunk.pending && (
            <span className="composer__dual-pending">
              {t("composer.dualPending")}
            </span>
          )}
        </div>
      )}
      {isAutoMode && autoSession.spans.length > 0 && (
        <div
          className="composer__spans"
          role="region"
          aria-label={t("composer.spansAria")}
        >
          {autoSession.spans.map((span) => {
            const displayText = span.language === "ko" ? span.ko : span.en;
            if (!displayText && !span.separator) return null;
            return (
              <button
                key={span.id}
                type="button"
                disabled={Boolean(span.isPrefix) || !span.keys || streaming}
                className={`composer__span-chip ${
                  span.isOverridden ? "composer__span-chip--overridden" : ""
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleSpanOverride(span.id);
                }}
                title={t("composer.spanOverrideTitle")}
              >
                <span className="composer__span-text">
                  {displayText || span.separator}
                </span>
                <span
                  className={`composer__span-badge composer__span-badge--${span.language}`}
                >
                  {span.isResolved || span.isOverridden
                    ? span.language.toUpperCase()
                    : (autoSession.error ?? t("composer.dualAutoResolving"))}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {correction && !streaming && (
        <button
          type="button"
          className="composer__correction"
          onClick={applyCorrection}
          title={t("composer.correctionTitle")}
        >
          <span className="composer__correction-label">
            {t("composer.correctionLabel")}
          </span>
          {correction}
        </button>
      )}
      {(localPredictions.length > 0 ||
        providerPredictions.length > 0 ||
        hasPredictionProvider ||
        aiLoading) &&
        !streaming && (
          <div
            className="composer__suggest"
            role="listbox"
            aria-label={t("composer.predictionsAria")}
          >
            <div className="composer__suggest-head">
              <span className="composer__suggest-title">
                {t("composer.predictionsTitle")}
              </span>
              {hasPredictionProvider && (
                <button
                  type="button"
                  className="composer__suggest-ai"
                  onClick={requestProviderPredictions}
                  disabled={aiLoading || !text.trim()}
                >
                  {t("composer.requestAiPredictions")}
                </button>
              )}
              {aiLoading && (
                <span className="composer__predicting" aria-live="polite">
                  {t("composer.aiPredictLoading")}
                </span>
              )}
            </div>
            <div className="composer__suggest-list">
              {[...localPredictions, ...providerPredictions]
                .slice(0, 5)
                .map((prediction, idx) => (
                  <button
                    key={`${prediction.source}-${idx}`}
                    type="button"
                    className={`composer__suggest-line ${
                      idx === 0 ? "composer__suggest-line--first" : ""
                    }`}
                    onClick={() => applyPrediction(prediction)}
                  >
                    <span
                      className={`composer__suggest-src composer__suggest-src--${prediction.source}`}
                    >
                      {t(
                        `composer.predictionSrc${
                          prediction.source.charAt(0).toUpperCase() +
                          prediction.source.slice(1)
                        }`,
                      )}
                    </span>
                    <span className="composer__suggest-text">
                      {prediction.text}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        )}
      {showDiff && (
        <div className="composer__diff" role="region" aria-label="diff">
          <div className="composer__diff-body">
            {diffSegments.length === 0 ? (
              <span className="composer__diff-empty">
                {t("composer.diffEmpty")}
              </span>
            ) : (
              diffSegments.map((seg, idx) => (
                <span
                  key={idx}
                  className={`composer__diff-token composer__diff-token--${seg.type}`}
                >
                  {seg.text}
                </span>
              ))
            )}
          </div>
        </div>
      )}
      <div className="composer__hint">
        <span className={statusClass} />
        <span className="composer__state">
          {streaming
            ? t("composer.stateStreaming")
            : isDraining ||
                autoSession.isResolving ||
                (isAutoMode &&
                  !autoSession.error &&
                  !autoInputState.error &&
                  (hasUnresolvedSpans(autoSession) ||
                    (autoSession.activeKeys &&
                      !autoSession.trailingPreviewResolved)))
              ? t("composer.stateResolvingAuto")
              : autoSession.error || autoInputState.error || manualPreviewError
                ? autoSession.error ||
                  autoInputState.error ||
                  manualPreviewError
                : error
                  ? error
                  : isComposing
                    ? t("composer.stateComposing")
                    : isAutoMode
                      ? t("composer.stateIdleAuto")
                      : t("composer.stateIdle")}
        </span>
        {!streaming && revisionState.revisions.length > 0 && (
          <span className="composer__actions">
            <button
              type="button"
              className="composer__action"
              onClick={undo}
              disabled={!canUndo(revisionState)}
              title={t("composer.undoTitle")}
              aria-label={t("composer.undoAria")}
            >
              {"↶"}
            </button>
            <button
              type="button"
              className="composer__action"
              onClick={redo}
              disabled={!canRedo(revisionState)}
              title={t("composer.redoTitle")}
              aria-label={t("composer.redoAria")}
            >
              {"↷"}
            </button>
            <button
              type="button"
              className={`composer__action ${showDiff ? "composer__action--active" : ""}`}
              onClick={() => setShowDiff((v) => !v)}
              title={t("composer.diffTitle")}
              aria-label={t("composer.diffAria")}
            >
              {"Δ"}
            </button>
          </span>
        )}
        {streaming && (
          <button
            type="button"
            className="composer__cancel"
            onClick={cancelInFlight}
          >
            {t("composer.cancel")}
          </button>
        )}
        {!streaming && (
          <span className="composer__keys">
            {isAutoMode ? t("composer.keysHintAuto") : t("composer.keysHint")}
          </span>
        )}
      </div>
    </div>
  );
};

export default Composer;
