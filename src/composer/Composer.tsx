import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./Composer.css";

// IME input (한글 조합) must reach the textarea untouched. Our own hotkeys
// (Enter = commit, Esc = cancel) are deliberately suppressed while the OS IME
// is composing, so those keys keep their IME meanings (confirm / cancel the
// composition) instead of firing a commit or close mid-syllable.
const Composer: React.FC = () => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [isComposing, setIsComposing] = useState(false);

  // Each time the backend opens the composer it emits "composer-open": clear
  // the previous draft and focus the textarea so the user can immediately type.
  useEffect(() => {
    let disposed = false;
    void listen("composer-open", () => {
      if (disposed) return;
      setText("");
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    });
    return () => {
      disposed = true;
    };
  }, []);

  const commit = () => {
    const value = text.trim();
    // Empty text is ignored (backend enforces the same guard).
    if (value.length === 0) {
      void invoke("cancel_composer");
      return;
    }
    void invoke("commit_composer", { text });
  };

  const cancel = () => {
    void invoke("cancel_composer");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // While the IME composes, Enter finalizes the current syllable and Esc
    // cancels the in-progress composition — never treat those as commit/close.
    if (e.nativeEvent.isComposing) {
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div
      className={`composer ${isComposing ? "composer--composing" : ""}`}
      onClick={() => textareaRef.current?.focus()}
    >
      <div className="composer__glow" aria-hidden="true" />
      <textarea
        ref={textareaRef}
        className="composer__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder="타자기 컴포저 — 입력 후 Enter로 붙여넣기, Esc로 취소"
        autoFocus
        spellCheck={false}
      />
      <div className="composer__hint">
        <span className="composer__status" />
        <span className="composer__keys">
          {isComposing ? "조합 중" : "Enter 커밋 · Esc 취소"}
        </span>
        <span className="composer__keys">{"Shift+Enter 줄바꿈"}</span>
      </div>
    </div>
  );
};

export default Composer;