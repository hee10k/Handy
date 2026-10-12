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
  instruction: string | null; // null reads the finalized custom-instruction editor
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

type InputMode = "bilingual" | "edit";
type ComposingEditor = "text" | "instruction";

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

// IME input must reach the editable textarea untouched. Final-commit and close
// shortcuts retain their IME meaning while either editor is composing.
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
  const [inputMode, setInputMode] = useState<InputMode>("bilingual");
  const [chunkWarning, setChunkWarning] = useState<string | null>(null);
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
  const compositionRef = useRef<ComposingEditor | null>(null);
  const inputModeRef = useRef<InputMode>("bilingual");
  const pendingInputModeRef = useRef<InputMode | null>(null);
  const chunkRef = useRef<ChunkState>(EMPTY_CHUNK);
  // Text last written into the editor DOM. The textarea is uncontrolled (see
  // `writeText`), so programmatic writes track the element through this ref
  // instead of a React value prop.
  const textValueRef = useRef("");

  // Keep the editor uncontrolled on purpose. React's controlled <textarea>
  // rewrites `node.defaultValue` on every commit (ReactDOMTextarea.updateWrapper:
  // `node.defaultValue = newValue`), and that setter replaces the element's child
  // text node. Each of those mutations ends Chromium's current typing session, so
  // one typed run becomes one undo step per character. Leaving the DOM
  // authoritative while the user types keeps the native undo/redo stack intact;
  // every programmatic change goes through this single writer so the element and
  // `text` never diverge.
  const writeText = (update: string | ((current: string) => string)) => {
    const next =
      typeof update === "function" ? update(textValueRef.current) : update;
    textValueRef.current = next;
    const el = textareaRef.current;
    if (el && el.value !== next) el.value = next;
    setText(next);
  };

  const updateChunk = (
    update: ChunkState | ((current: ChunkState) => ChunkState),
  ) => {
    const next =
      typeof update === "function" ? update(chunkRef.current) : update;
    chunkRef.current = next;
    setChunk(next);
  };

  const applyInputMode = (next: InputMode) => {
    inputModeRef.current = next;
    setInputMode(next);
  };

  const requestInputMode = (next: InputMode) => {
    if (streamingRef.current) return;
    if (compositionRef.current) {
      pendingInputModeRef.current = next;
      return;
    }
    applyInputMode(next);
    textareaRef.current?.focus();
  };

  const beginComposition = (editor: ComposingEditor) => {
    if (editor === "text" && streamingRef.current) return;
    compositionRef.current = editor;
    setIsComposing(true);
  };

  const rejectUnconfirmedChunk = () => {
    if (chunkRef.current.keys.length === 0) return false;
    setChunkWarning(t("composer.unconfirmedChunkWarning"));
    return true;
  };

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
    if (rejectUnconfirmedChunk()) return;
    const requestId = ++providerPredictionRequestRef.current;
    const draft = text.trim();
    if (
      !draft ||
      !hasPredictionProvider ||
      streamingRef.current ||
      compositionRef.current
    )
      return;
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
      writeText((prev) => {
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
          writeText((t) => t + e.payload.delta);
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
          writeText(e.payload.text); // authoritative final result, now editable
          dispatchRevision({ type: "append", text: e.payload.text });
          if (compositionRef.current) pendingInputModeRef.current = "edit";
          else applyInputMode("edit");
        }),
        listen<TransformErrorPayload>("transform-error", (e) => {
          if (disposed || e.payload.mode !== modeRef.current) return;
          streamingRef.current = false;
          setStreaming(false);
          writeText(originalTextRef.current); // never lose the typed text
          setError(e.payload.error);
        }),
        listen("composer-open", () => {
          if (disposed) return;
          // Fresh draft: cancel any in-flight transform, clear all state, focus.
          void invoke("cancel_transform");
          streamingRef.current = false;
          pendingTransformRef.current = null;
          pendingInputModeRef.current = null;
          compositionRef.current = null;
          modeRef.current = null;
          writeText("");
          setOriginalText("");
          setMode(null);
          setInstruction("");
          setStreaming(false);
          setError(null);
          setIsComposing(false);
          applyInputMode("bilingual");
          updateChunk(EMPTY_CHUNK);
          setChunkWarning(null);
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
    if (streamingRef.current || rejectUnconfirmedChunk()) return;
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
    writeText(""); // begin streaming the result fresh
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
      writeText(originalTextRef.current);
      setError(String(err));
    });
  };

  // Request a transform. If the IME is mid-composition, defer until
  // `compositionend` so no syllable is dropped; otherwise run immediately.
  const requestTransform = (selectedMode: string, instr: string) => {
    if (streamingRef.current || rejectUnconfirmedChunk()) return;
    if (compositionRef.current) {
      pendingTransformRef.current = {
        mode: selectedMode,
        instruction:
          selectedMode === "custom" && compositionRef.current === "instruction"
            ? null
            : instr,
      };
      return;
    }
    transformNow(selectedMode, instr);
  };

  const handleModeClick = (m: TransformModeInfo) => {
    if (streamingRef.current || rejectUnconfirmedChunk()) return;
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
    if (streamingRef.current || rejectUnconfirmedChunk()) return;
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
    if (streamingRef.current) return;
    const next =
      prediction.source === "provider"
        ? `${text}${text.endsWith(" ") || text.endsWith("\n") ? "" : " "}${prediction.text} `
        : text.endsWith(" ") || text.endsWith("\n")
          ? `${text}${prediction.text} `
          : `${text.replace(/\S+$/, "")}${prediction.text} `;
    writeText(next);
    dispatchRevision({ type: "replace-current", text: next });
    setLocalPredictions([]);
    setProviderPredictions([]);
    textareaRef.current?.focus();
  };

  const applyCorrection = () => {
    if (streamingRef.current || !correction) return;
    writeText(correction);
    dispatchRevision({ type: "replace-current", text: correction });
    setCorrection(null);
    textareaRef.current?.focus();
  };

  // 이중 언어 입력 (ticket 10): 선택된 언어로 현재 구를 초안에 append 하고
  // 리비전을 replace-current 로 갱신한다 (기존 applyPrediction/applyCorrection 와 동일 정책).
  const commitChunk = (lang: "ko" | "en") => {
    if (
      streamingRef.current ||
      compositionRef.current ||
      chunkRef.current.keys.length === 0
    )
      return;
    const raw = chunkRef.current.keys.join("");
    const picked = lang === "ko" ? keysToHangul(raw) : raw;
    const current = textareaRef.current?.value ?? text;
    const sep = current && !current.endsWith(" ") ? " " : "";
    const next = `${current}${sep}${picked} `;
    updateChunk(EMPTY_CHUNK);
    setChunkWarning(null);
    writeText(next);
    setLocalPredictions([]);
    setProviderPredictions([]);
    dispatchRevision({ type: "replace-current", text: next });
    textareaRef.current?.focus();
  };

  const handleInstructionKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!compositionRef.current) commit();
      return;
    }
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
      requestTransform("custom", e.currentTarget.value);
      return;
    }
    if (e.key === "Escape") {
      if (compositionRef.current) return;
      e.preventDefault();
      if (chunkRef.current.keys.length > 0) {
        updateChunk(EMPTY_CHUNK);
        setChunkWarning(null);
        return;
      }
      if (streamingRef.current) cancelInFlight();
      else cancel();
      return;
    }
  };

  const completeComposition = (editor: ComposingEditor, value: string) => {
    if (compositionRef.current !== editor) return;
    compositionRef.current = null;
    setIsComposing(false);
    const pendingMode = pendingInputModeRef.current;
    const pendingTransform = pendingTransformRef.current;
    pendingInputModeRef.current = null;
    pendingTransformRef.current = null;
    // The stream owns both the displayed result and the saved draft revision.
    if (streamingRef.current) return;
    if (editor === "text" && inputModeRef.current === "edit") {
      writeText(value);
      dispatchRevision({ type: "replace-current", text: value });
    } else if (editor === "instruction") {
      setInstruction(value);
    }
    if (pendingMode) applyInputMode(pendingMode);
    if (pendingTransform) {
      transformNow(
        pendingTransform.mode,
        pendingTransform.instruction ??
          instructionRef.current?.value ??
          instruction,
      );
    }
  };

  const commit = () => {
    if (
      streamingRef.current ||
      compositionRef.current ||
      rejectUnconfirmedChunk()
    )
      return;
    const current = textareaRef.current?.value ?? text;
    const value = current.trim();
    // Empty text is ignored (backend enforces the same guard).
    if (value.length === 0) {
      void invoke("cancel_composer");
      return;
    }
    // Reuse the ticket-02 commit path: paste current textarea text at the
    // previously-focused app's cursor, then restore the clipboard.
    void invoke("commit_composer", { text: current });
  };

  const cancelInFlight = () => {
    // Cancel only this transform request; keep the composer open and restore
    // the pre-transform text so nothing is pasted and nothing is lost.
    void invoke("cancel_transform");
    streamingRef.current = false;
    pendingTransformRef.current = null;
    pendingInputModeRef.current = null;
    setStreaming(false);
    setError(null);
    writeText(originalTextRef.current);
  };

  const cancel = () => {
    pendingTransformRef.current = null;
    pendingInputModeRef.current = null;
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
    if (streamingRef.current || !canUndo(revisionState)) return;
    dispatchRevision({ type: "undo" });
    writeText(revisionState.revisions[revisionState.index - 1]);
  };
  const redo = () => {
    if (streamingRef.current || !canRedo(revisionState)) return;
    dispatchRevision({ type: "redo" });
    writeText(revisionState.revisions[revisionState.index + 1]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the IME composes, Enter finalizes the current syllable and Esc
    // cancels the in-progress composition — never treat those as commit/close.
    if (e.nativeEvent.isComposing || e.keyCode === 229) {
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
    // Cmd/Ctrl+Enter: 최종 커밋
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      if (!compositionRef.current) commit();
      return;
    }
    // Revision shortcuts are bilingual-only; edit mode keeps native history.
    if (
      inputModeRef.current === "bilingual" &&
      (e.metaKey || e.ctrlKey) &&
      (e.key === "z" || e.key === "Z")
    ) {
      e.preventDefault();
      if (streamingRef.current) return;
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (
      inputModeRef.current === "bilingual" &&
      (e.metaKey || e.ctrlKey) &&
      (e.key === "y" || e.key === "Y")
    ) {
      e.preventDefault();
      if (streamingRef.current) return;
      redo();
      return;
    }
    if (e.key === "Tab") {
      const first = [...localPredictions, ...providerPredictions][0];
      if (first && !streamingRef.current && !aiLoading) {
        e.preventDefault();
        applyPrediction(first);
      }
      return;
    }
    if (e.key === "Escape") {
      if (compositionRef.current) return;
      e.preventDefault();
      if (chunkRef.current.keys.length > 0) {
        updateChunk(EMPTY_CHUNK);
        setChunkWarning(null);
        return;
      }
      if (chunkWarning) {
        setChunkWarning(null);
        return;
      }
      if (localPredictions.length > 0 || providerPredictions.length > 0) {
        setLocalPredictions([]);
        setProviderPredictions([]);
        return;
      }
      if (streamingRef.current)
        cancelInFlight(); // Esc cancels only the in-flight request
      else cancel(); // nothing streaming: close the composer
      return;
    }

    if (streamingRef.current) return;

    // In Edit text mode, allow normal editing (letters, numbers, space, enter, backspace, etc.)
    if (inputModeRef.current === "edit") {
      return;
    }

    // === 이중 언어 입력 (ticket 10) ===
    // modifier 없는 A-Z 는 물리 키로 캡처해 두바식 엔진으로 이중 해석한다.
    // IME가 켜져 있어도 keydown 의 e.code 는 물리 키 그대로 도착한다 (Task 1 POC 실측).
    const letter = keyChar(e.nativeEvent.code, e.shiftKey);
    if (letter && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setChunkWarning(null);
      updateChunk((c) => ({ keys: [...c.keys, letter], pending: false }));
      return;
    }
    // Space: 단어 경계 (두 창 모두 공백 반영)
    if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setChunkWarning(null);
      updateChunk((c) => ({ keys: [...c.keys, " "], pending: false }));
      return;
    }
    // Backspace: 구가 비어있지 않으면 양 창을 동시에 롤백
    if (e.key === "Backspace" && chunkRef.current.keys.length > 0) {
      e.preventDefault();
      setChunkWarning(null);
      updateChunk((c) => ({ keys: c.keys.slice(0, -1), pending: false }));
      return;
    }
    // Enter: 구가 있으면 1/2 선택을 강제 (pending). 빈 구는 no-op.
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (chunkRef.current.keys.length > 0)
        updateChunk((c) => ({ ...c, pending: true }));
      return;
    }
    // 1/2: 구 확정 → 초안 append. 구가 없으면 1/2 는 일반 문자(리터럴).
    if (
      chunkRef.current.keys.length > 0 &&
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
      setChunkWarning(null);
      updateChunk((c) => ({ keys: [...c.keys, e.key], pending: false }));
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
      setChunkWarning(null);
      updateChunk((c) => ({ keys: [...c.keys, e.key], pending: false }));
      return;
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
      onClick={() => {
        if (!compositionRef.current) textareaRef.current?.focus();
      }}
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
            onCompositionStart={() => beginComposition("instruction")}
            onCompositionEnd={(e) =>
              completeComposition("instruction", e.currentTarget.value)
            }
            placeholder={t("composer.instructionPlaceholder")}
            spellCheck={false}
          />
        </>
      )}
      <div
        className="composer__input-modes"
        role="group"
        aria-label={t("composer.inputModeSwitchAria")}
      >
        <button
          type="button"
          className={`composer__input-mode-btn ${
            inputMode === "bilingual" ? "composer__input-mode-btn--active" : ""
          }`}
          disabled={streaming}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            requestInputMode("bilingual");
          }}
        >
          {t("composer.modeBilingual")}
        </button>
        <button
          type="button"
          className={`composer__input-mode-btn ${
            inputMode === "edit" ? "composer__input-mode-btn--active" : ""
          }`}
          disabled={streaming}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            requestInputMode("edit");
          }}
        >
          {t("composer.modeEditText")}
        </button>
      </div>
      {chunkWarning && (
        <div className="composer__alert" role="alert" aria-live="assertive">
          {chunkWarning}
        </div>
      )}
      {/* Uncontrolled on purpose (see `writeText`): a controlled `value` prop
          makes React rewrite <textarea>.defaultValue on every keystroke, which
          closes Chromium's typing session and fragments native undo. */}
      <textarea
        ref={textareaRef}
        className="composer__input"
        onChange={(e) => {
          if (streamingRef.current || inputModeRef.current !== "edit") return;
          const next = e.target.value;
          setProviderPredictions([]);
          writeText(next);
          // Mirror the live draft into the current revision (replaces it and
          // drops any redo tail — the ticket-05 edit-after-rewind rule).
          dispatchRevision({ type: "replace-current", text: next });
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => beginComposition("text")}
        onCompositionEnd={(e) =>
          completeComposition("text", e.currentTarget.value)
        }
        onBeforeInput={(e) => {
          if (streamingRef.current) {
            e.preventDefault();
            return;
          }
          // 이중 언어 입력 (ticket 10): bilingual 모드에서는 textarea 는 초안 표시 전용.
          if (inputModeRef.current === "bilingual") {
            const ie = e as unknown as InputEvent;
            if (
              ie.inputType === "insertCompositionText" ||
              ie.inputType === "insertText" ||
              ie.inputType === "insertLineBreak"
            ) {
              e.preventDefault();
            }
          }
        }}
        placeholder={t("composer.inputPlaceholder")}
        autoFocus
        readOnly={streaming || inputMode !== "edit"}
        spellCheck={false}
      />
      {chunk.keys.length > 0 && (
        <div
          className="composer__dual"
          role="region"
          aria-label={t("composer.dualAria")}
        >
          <div className="composer__dual-row">
            <button
              type="button"
              className="composer__dual-btn"
              disabled={streaming || isComposing}
              onClick={(e) => {
                e.stopPropagation();
                commitChunk("ko");
              }}
              aria-label="1"
            >
              1
            </button>
            <span className="composer__dual-src">{t("composer.dualKo")}</span>
            <span className="composer__dual-text">{koText}</span>
          </div>
          <div className="composer__dual-row">
            <button
              type="button"
              className="composer__dual-btn"
              disabled={streaming || isComposing}
              onClick={(e) => {
                e.stopPropagation();
                commitChunk("en");
              }}
              aria-label="2"
            >
              2
            </button>
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
