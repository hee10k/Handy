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
    return () => {
      disposed = true;
    };
  }, []);

  // Load the user's saved instructions (settings `post_process_prompts`) so the
  // Custom mode can select one instead of typing fresh (Spec-8).
  useEffect(() => {
    let disposed = false;
    void invoke<{ post_process_prompts?: SavedInstruction[] }>("get_app_settings")
      .then((settings) => {
        if (!disposed) setSavedPrompts(settings?.post_process_prompts ?? []);
      })
      .catch(() => {
        // No saved prompts; the Custom mode falls back to inline typing.
      });
    return () => {
      disposed = true;
    };
  }, []);

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
          if (disposed || !streamingRef.current || e.payload.mode !== modeRef.current) return;
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

  const handleInstructionKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // let the IME finalize the instruction
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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming) return; // never commit a partial stream
      commit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (streaming) cancelInFlight(); // Esc cancels only the in-flight request
      else cancel(); // nothing streaming: close the composer (ticket-02 path)
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
      <button
        type="button"
        className="composer__close"
        aria-label={t("composer.closeTitle")}
        title={t("composer.closeTitle")}
        onClick={(e) => {
          e.stopPropagation();
          cancel();
        }}
      >
        {String.fromCharCode(0x2715)}
      </button>
      {modes.length > 0 && (
        <div className="composer__modes" role="group" aria-label={t("composer.modesAriaLabel")}>
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
              <option value="">{t("composer.savedInstructionPlaceholder")}</option>
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
          setText(e.target.value);
          // Mirror the live draft into the current revision (replaces it and
          // drops any redo tail — the ticket-05 edit-after-rewind rule).
          dispatchRevision({ type: "replace-current", text: e.target.value });
        }}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={finalizeComposition}
        placeholder={t("composer.inputPlaceholder")}
        autoFocus
        readOnly={streaming}
        spellCheck={false}
      />
      {showDiff && (
        <div className="composer__diff" role="region" aria-label="diff">
          <div className="composer__diff-body">
            {diffSegments.length === 0 ? (
              <span className="composer__diff-empty">{t("composer.diffEmpty")}</span>
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
          <button type="button" className="composer__cancel" onClick={cancelInFlight}>
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