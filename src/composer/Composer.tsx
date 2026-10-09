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
  const [text, setText] = useState("");
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
  const [chunk, setChunk] = useState<ChunkState>(EMPTY_CHUNK);
  const koText = useMemo(() => keysToHangul(chunk.keys.join("")), [chunk.keys]);
  const enText = useMemo(() => chunk.keys.join(""), [chunk.keys]);
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
      setText((prev) => {
        const next =
          (prev && !prev.endsWith(" ") ? `${prev} ` : prev) + incoming;
        dispatchRevision({ type: "replace-current", text: next });
        return next;
      });
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
    void (async () => {
      const [onDelta, onDone, onError, onOpen] = await Promise.all([
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
          setText(e.payload.text); // authoritative final result, now editable
          dispatchRevision({ type: "append", text: e.payload.text });
        }),
        listen<TransformErrorPayload>("transform-error", (e) => {
          if (disposed || e.payload.mode !== modeRef.current) return;
          streamingRef.current = false;
          setStreaming(false);
          setText(originalTextRef.current); // never lose the typed text
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
      ]);
      unlisteners.push(onDelta, onDone, onError, onOpen);
    })();
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
    const el = textareaRef.current;
    const value = (el?.value ?? text).trim();
    if (value.length === 0) return; // empty/whitespace input is a no-op
    const instructionArg = instr.trim();
    if (selectedMode === "custom" && instructionArg.length === 0) return; // needs an instruction
    originalTextRef.current = value;
    setOriginalText(value);
    modeRef.current = selectedMode;
    streamingRef.current = true;
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
      setText(originalTextRef.current);
      setError(String(err));
    });
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
    setText(next);
    dispatchRevision({ type: "replace-current", text: next });
    setLocalPredictions([]);
    setProviderPredictions([]);
    textareaRef.current?.focus();
  };

  const applyCorrection = () => {
    if (!correction) return;
    setText(correction);
    dispatchRevision({ type: "replace-current", text: correction });
    setCorrection(null);
    textareaRef.current?.focus();
  };

  // 이중 언어 입력 (ticket 10): 선택된 언어로 현재 구를 초안에 append 하고
  // 리비전을 replace-current 로 갱신한다 (기존 applyPrediction/applyCorrection 와 동일 정책).
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
    const value = text.trim();
    // Empty text is ignored (backend enforces the same guard).
    if (value.length === 0) {
      void invoke("cancel_composer");
      return;
    }
    // Reuse the ticket-02 commit path: paste current textarea text at the
    // previously-focused app's cursor, then restore the clipboard.
    void invoke("commit_composer", { text });
  };

  const cancelInFlight = () => {
    // Cancel only this transform request; keep the composer open and restore
    // the pre-transform text so nothing is pasted and nothing is lost.
    void invoke("cancel_transform");
    streamingRef.current = false;
    pendingTransformRef.current = null;
    setStreaming(false);
    setError(null);
    setText(originalTextRef.current);
  };

  const cancel = () => {
    void invoke("cancel_composer");
  };

  const openSettings = () => {
    // Leave the compositing session before showing settings: the composer is
    // an always-on-top window, and switching the app to Regular activation for
    // the settings window lets macOS dismiss/interleave the floating composer
    // next to it (reported as both closing together). Closing the composer
    // first makes the transition deterministic: composer down, settings up.
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
    setText(revisionState.revisions[revisionState.index - 1]);
  };
  const redo = () => {
    if (!canRedo(revisionState)) return;
    dispatchRevision({ type: "redo" });
    setText(revisionState.revisions[revisionState.index + 1]);
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
    // === 이중 언어 입력 (ticket 10) ===
    // modifier 없는 A-Z 는 물리 키로 캡처해 두바식 엔진으로 이중 해석한다.
    // IME가 켜져 있어도 keydown 의 e.code 는 물리 키 그대로 도착한다 (Task 1 POC 실측).
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
    // Cmd/Ctrl+Enter: 최종 커밋 (기존 Enter 커밋을 modifier 로 이동)
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!streaming) commit();
      return;
    }
    // === 이중 언어 입력 끝 ===
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
          setText(next);
          // Mirror the live draft into the current revision (replaces it and
          // drops any redo tail — the ticket-05 edit-after-rewind rule).
          dispatchRevision({ type: "replace-current", text: next });
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
      {chunk.keys.length > 0 && (
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
          {chunk.pending && (
            <span className="composer__dual-pending">
              {t("composer.dualPending")}
            </span>
          )}
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
            : error
              ? error
              : isComposing
                ? t("composer.stateComposing")
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
          <span className="composer__keys">{t("composer.keysHint")}</span>
        )}
      </div>
    </div>
  );
};

export default Composer;
