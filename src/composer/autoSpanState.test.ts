import { describe, expect, it } from "vitest";
import type { AutoInputDecision } from "@/bindings";
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
  resetAutoSpanSession,
  transitionAutoToManual,
  transitionManualToAuto,
  type AutoSpanSession,
} from "./autoSpanState";

function typeString(session: AutoSpanSession, text: string) {
  for (const key of text) session = inputKey(session, key).nextSession;
  return session;
}

function resolveWords(session: AutoSpanSession) {
  const request = getSpansForResolution(session);
  const decisions: AutoInputDecision[] = request.spans.map((span) => ({
    id: span.id,
    language: span.en === "dhsmf" ? "ko" : "en",
  }));
  return applyDecisions(session, request.generation, decisions);
}

describe("automatic draft", () => {
  it("preserves mixed languages, digits and every separator", () => {
    const session = resolveWords(
      typeString(createInitialAutoSpanState(), "  dhsmf meeting 123 ! test.\n"),
    );
    expect(renderDraftText(session)).toBe("  오늘 meeting 123 ! test.\n");
  });

  it("drains the unfinished last word, not just its preview", () => {
    let session = typeString(createInitialAutoSpanState(), "dhsmf meeting");
    session = applyTrailingPreview(session, session.generation, "en");
    expect(renderDraftText(session)).toBe("오늘 meeting");
    session = flushActiveSpan(session).nextSession;
    expect(hasUnresolvedSpans(session)).toBe(true);
    expect(getSpansForResolution(session).spans.map((span) => span.en)).toEqual(
      ["dhsmf", "meeting"],
    );
    session = resolveWords(session);
    expect(hasUnresolvedSpans(session)).toBe(false);
    expect(renderDraftText(session)).toBe("오늘 meeting");
  });

  it("keeps an override pinned against both stale and matching decisions", () => {
    let session = typeString(createInitialAutoSpanState(), "dhsmf ");
    const generation = session.generation;
    const id = session.spans[0].id;
    session = overrideSpanLanguage(session, id, "en");
    session = applyDecisions(session, generation, [{ id, language: "ko" }]);
    session = applyDecisions(session, session.generation, [
      { id, language: "ko" },
    ]);
    expect(renderDraftText(session)).toBe("dhsmf ");
  });

  it("reopens a pinned word after deleting its delimiter and scores the combined keys", () => {
    let session = typeString(createInitialAutoSpanState(), "hello ");
    const oldId = session.spans[0].id;
    const generation = session.generation;
    session = overrideSpanLanguage(session, oldId, "en");
    session = handleBackspace(session);
    session = typeString(session, "world ");
    session = applyDecisions(session, generation, [
      { id: oldId, language: "ko" },
    ]);
    expect(getSpansForResolution(session).spans.map((span) => span.en)).toEqual(
      ["helloworld"],
    );
    expect(renderDraftText(resolveWords(session))).toBe("helloworld ");
  });

  it("edits a flushed final word without retaining its old pinned decision", () => {
    let session = flushActiveSpan(
      typeString(createInitialAutoSpanState(), "hello"),
    ).nextSession;
    session = overrideSpanLanguage(session, session.spans[0].id, "en");
    session = handleBackspace(session);
    session = typeString(session, "p ");
    expect(getSpansForResolution(session).spans.map((span) => span.en)).toEqual(
      ["hellp"],
    );
    // The edited word is re-scored: the old explicit "en" pin is gone.
    expect(session.spans[0].isOverridden).toBe(false);
    expect(session.spans[0].isResolved).toBe(false);
    expect(renderDraftText(resolveWords(session))).toBe("hellp ");
  });

  it("removes a literal Unicode prefix one character at a time", () => {
    let session = transitionManualToAuto("초안🙂", []);
    session = handleBackspace(session);
    expect(renderDraftText(session)).toBe("초안");
    session = handleBackspace(session);
    expect(renderDraftText(session)).toBe("초");
    expect(getSpansForResolution(session).spans).toEqual([]);
  });

  it("rebases mode cycles on the latest manual prefix and segments pending raw keys", () => {
    let session = resolveWords(
      typeString(createInitialAutoSpanState(), "dhsmf "),
    );
    const manual = transitionAutoToManual(session);
    session = transitionManualToAuto(
      manual.committedText + "new draft ",
      Array.from("meeting dhsmf"),
      session,
    );
    expect(getSpansForResolution(session).spans.map((span) => span.en)).toEqual(
      ["meeting"],
    );
    expect(session.activeKeys).toBe("dhsmf");
    session = resolveWords(flushActiveSpan(session).nextSession);
    expect(renderDraftText(session)).toBe("오늘 new draft meeting 오늘");
  });

  it("keeps unresolved keys physical when leaving automatic mode", () => {
    let session = typeString(
      createInitialAutoSpanState(),
      "dhsmf meeting tail",
    );
    session = applyDecisions(session, session.generation, [
      { id: session.spans[0].id, language: "ko" },
    ]);
    const manual = transitionAutoToManual(session);
    expect(manual.committedText).toBe("오늘 ");
    expect(manual.chunkKeys.join("")).toBe("meeting tail");
    session = transitionManualToAuto(
      manual.committedText,
      manual.chunkKeys,
      session,
    );
    session = resolveWords(flushActiveSpan(session).nextSession);
    expect(renderDraftText(session)).toBe("오늘 meeting tail");
  });

  it("retains literal text following unresolved physical keys on a mode change", () => {
    const raw = typeString(createInitialAutoSpanState(), "meeting ");
    const literal = transitionManualToAuto("음성🙂", [], raw);
    const manual = transitionAutoToManual({
      ...literal,
      spans: [...raw.spans, ...literal.spans],
    });
    expect(manual.committedText).toBe("");
    expect(manual.chunkKeys.join("")).toBe("meeting 음성🙂");
  });

  it("rejects an old trailing preview after editing or resetting", () => {
    let session = typeString(createInitialAutoSpanState(), "meeting");
    const generation = session.generation;
    session = inputKey(session, "s").nextSession;
    const edited = applyTrailingPreview(session, generation, "en");
    expect(edited).toBe(session);
    session = resetAutoSpanSession(session);
    session = typeString(session, "dhsmf");
    expect(applyTrailingPreview(session, generation, "en")).toBe(session);
    expect(renderDraftText(session)).toBe("오늘");
  });

  it("does not resurrect deleted spans with late decisions", () => {
    let session = resolveWords(
      typeString(createInitialAutoSpanState(), "dhsmf meeting "),
    );
    const generation = session.generation;
    const id = session.spans[1].id;
    for (const _key of "meeting ") session = handleBackspace(session);
    session = applyDecisions(session, generation, [{ id, language: "en" }]);
    expect(renderDraftText(session)).toBe("오늘 ");
  });
});
