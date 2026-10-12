import { expect, test, type Page } from "@playwright/test";

type HostCall = { command: string; args: Record<string, unknown> };
type HostEvent = { event: string; id: number; payload: unknown };
interface ComposerHost {
  calls: HostCall[];
  closed: boolean;
  emit: (event: string, payload: unknown) => void;
}
declare global {
  interface Window {
    __COMPOSER_HOST__: ComposerHost;
  }
}

// Only the unavailable native host is substituted; React and keyboard behavior
// run unchanged. Native focus, IME and credential storage have separate smoke runs.
async function installHost(page: Page) {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: HostEvent) => void>();
    const listeners = new Map<string, Map<number, number>>();
    let nextId = 1;
    const host: ComposerHost = {
      calls: [],
      closed: false,
      emit(event, payload) {
        for (const [id, callbackId] of listeners.get(event) ?? []) {
          callbacks.get(callbackId)?.({ event, id, payload });
        }
      },
    };
    const globals = window as typeof window & {
      __TAURI_INTERNALS__: unknown;
      __TAURI_EVENT_PLUGIN_INTERNALS__: unknown;
      __TAURI_OS_PLUGIN_INTERNALS__: unknown;
    };
    globals.__COMPOSER_HOST__ = host;
    globals.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "composer" },
        currentWebview: { label: "composer" },
      },
      transformCallback(callback: (event: HostEvent) => void) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      async invoke(command: string, args: Record<string, unknown> = {}) {
        host.calls.push({ command, args });
        switch (command) {
          case "get_app_settings":
            return {
              app_language: "en",
              post_process_provider_id: "p0-synthetic-provider",
              post_process_models: { "p0-synthetic-provider": "p0-model" },
              post_process_prompts: [],
            };
          case "list_transform_modes":
            return [
              {
                id: "polish",
                name: "Polish",
                description: "",
                takes_instruction: false,
              },
              {
                id: "custom",
                name: "Custom",
                description: "",
                takes_instruction: true,
              },
            ];
          case "get_quick_action_slots":
            return [
              [1, "polish"],
              [4, "custom"],
            ];
          case "plugin:os|locale":
            return "en";
          case "get_foreground_app_category":
            return "other";
          case "get_continuation_suggestions":
          case "suggest_llm_continuations":
            return [];
          case "correct_text":
          case "cancel_transform":
          case "run_transform":
          case "show_main_window_command":
            return null;
          case "commit_composer":
          case "cancel_composer":
            host.closed = true;
            return null;
          case "plugin:event|listen": {
            const event = String(args.event);
            const callbackId = Number(args.handler);
            if (!callbacks.has(callbackId))
              throw new Error("Missing host event callback");
            const id = nextId++;
            const subscriptions =
              listeners.get(event) ?? new Map<number, number>();
            subscriptions.set(id, callbackId);
            listeners.set(event, subscriptions);
            return id;
          }
          case "plugin:event|unlisten":
            listeners.get(String(args.event))?.delete(Number(args.eventId));
            return null;
          default:
            throw new Error(`Unexpected composer host command: ${command}`);
        }
      },
    };
    globals.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(event: string, id: number) {
        listeners.get(event)?.delete(id);
      },
    };
    globals.__TAURI_OS_PLUGIN_INTERNALS__ = {
      platform: "macos",
      arch: "aarch64",
      family: "unix",
      eol: "\n",
    };
  });
}

async function confirmDraft(page: Page) {
  const editor = page.locator(".composer__input");
  await editor.focus();
  await page.keyboard.type("base");
  await page.keyboard.press("2");
  const draft = await editor.inputValue();
  expect(draft.trim()).toBe("base");
  return draft;
}

async function leaveChunk(page: Page) {
  await page.locator(".composer__input").focus();
  await page.keyboard.type("rk");
  await expect(page.locator(".composer__dual-text").first()).toHaveText("가");
  await expect(page.locator(".composer__dual-text").nth(1)).toHaveText("rk");
}

test.beforeEach(async ({ page }) => {
  await installHost(page);
  await page.goto("/src/composer/index.html");
  await expect(page.locator(".composer__input")).toBeVisible();
});

for (const action of ["transform", "commit", "provider suggestions"] as const) {
  test(`unconfirmed chunk survives rejected ${action}`, async ({ page }) => {
    const draft = await confirmDraft(page);
    await leaveChunk(page); // No Enter: accumulating keys are already unresolved.
    await page.evaluate(() => {
      window.__COMPOSER_HOST__.calls = [];
    });
    if (action === "transform") {
      await page
        .locator(".composer__mode")
        .filter({ hasText: "Polish" })
        .click();
    } else {
      await page.keyboard.press(
        action === "commit" ? "ControlOrMeta+Enter" : "ControlOrMeta+Shift+P",
      );
    }
    await expect(page.locator(".composer__input")).toHaveValue(draft);
    await expect(page.locator(".composer__dual-text").first()).toHaveText("가");
    await expect(page.locator(".composer__dual-text").nth(1)).toHaveText("rk");
    await expect(page.getByRole("alert")).toBeVisible();
    expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(
      false,
    );
    const requests = await page.evaluate(() =>
      window.__COMPOSER_HOST__.calls.filter(({ command }) =>
        ["run_transform", "suggest_llm_continuations"].includes(command),
      ),
    );
    expect(requests).toEqual([]);
  });
}

test("chunk-only commit does not close an unfinished draft", async ({
  page,
}) => {
  await leaveChunk(page);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".composer__dual-text").nth(1)).toHaveText("rk");
  expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(
    false,
  );
});

test("text-edit mode supports replacement, deletion and literal 1/2", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const editor = page.locator(".composer__input");
  await expect(editor).toBeEditable();
  await editor.fill("left-right");
  await editor.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(5, 10),
  );
  await page.keyboard.type("12");
  await expect(editor).toHaveValue("left-12");
  await page.keyboard.press("Backspace");
  await expect(editor).toHaveValue("left-1");
});

test("edited AI output remains available after revision undo and redo", async ({
  page,
}) => {
  const draft = await confirmDraft(page);
  await page.locator(".composer__mode").filter({ hasText: "Polish" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__COMPOSER_HOST__.calls.some(
          ({ command }) => command === "run_transform",
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() =>
    window.__COMPOSER_HOST__.emit("transform-done", {
      mode: "polish",
      text: "Provider result",
    }),
  );
  const editor = page.locator(".composer__input");
  await expect(editor).toHaveValue("Provider result");
  await expect(editor).toBeEditable();
  await editor.fill("Provider result edited 12");
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(editor).toHaveValue(draft);
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect(editor).toHaveValue("Provider result edited 12");
});

for (const modifier of ["Control", "Meta"]) {
  test(`instruction ${modifier}+Enter commits rather than transforms`, async ({
    page,
  }) => {
    const draft = await confirmDraft(page);
    await page.locator(".composer__mode").filter({ hasText: "Custom" }).click();
    const instruction = page.locator(".composer__instruction");
    await instruction.fill("Polish this draft");
    await instruction.press(`${modifier}+Enter`);
    const calls = await page.evaluate(() => window.__COMPOSER_HOST__.calls);
    expect(calls.filter(({ command }) => command === "run_transform")).toEqual(
      [],
    );
    expect(
      calls
        .filter(({ command }) => command === "commit_composer")
        .map(({ args }) => args.text),
    ).toEqual([draft]);
  });
}

for (const field of ["text", "instruction"] as const) {
  test(`${field} composition ignores commit shortcuts until a new explicit commit`, async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Edit text", exact: true }).click();
    const editor = page.locator(".composer__input");
    await editor.fill("draft");
    if (field === "instruction") {
      await page
        .locator(".composer__mode")
        .filter({ hasText: "Custom" })
        .click();
      await page.locator(".composer__instruction").fill("instruction");
    }
    const composing = page.locator(
      field === "text" ? ".composer__input" : ".composer__instruction",
    );
    await composing.focus();
    await composing.dispatchEvent("compositionstart", { data: "ㄱ" });
    // Native isComposing is deliberately absent: the active composition ref must guard this too.
    await composing.press("Control+Enter");
    await composing.press("Meta+Enter");
    await composing.evaluate(
      (element: HTMLInputElement | HTMLTextAreaElement) => {
        element.value += "가";
        element.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "가" }),
        );
      },
    );
    expect(
      await page.evaluate(() =>
        window.__COMPOSER_HOST__.calls.filter(({ command }) =>
          ["commit_composer", "run_transform", "cancel_composer"].includes(
            command,
          ),
        ),
      ),
    ).toEqual([]);
    await composing.press("Control+Enter");
    expect(
      await page.evaluate(() =>
        window.__COMPOSER_HOST__.calls
          .filter(({ command }) => command === "commit_composer")
          .map(({ args }) => args.text),
      ),
    ).toEqual([field === "text" ? "draft가" : "draft"]);
  });
}

test("instruction Escape discards the raw chunk before closing and preserves the instruction", async ({
  page,
}) => {
  const draft = await confirmDraft(page);
  await page.locator(".composer__mode").filter({ hasText: "Custom" }).click();
  const instruction = page.locator(".composer__instruction");
  await instruction.fill("Keep this instruction");
  await leaveChunk(page);
  await instruction.focus();
  await instruction.press("Enter");
  await expect(page.getByRole("alert")).toBeVisible();
  await instruction.press("Escape");
  await expect(page.locator(".composer__dual")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(instruction).toHaveValue("Keep this instruction");
  await expect(page.locator(".composer__input")).toHaveValue(draft);
  expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(
    false,
  );
  await instruction.press("Escape");
  expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(true);
});

test("instruction Escape cancels an in-flight custom transform and restores the draft", async ({
  page,
}) => {
  const draft = await confirmDraft(page);
  await page.locator(".composer__mode").filter({ hasText: "Custom" }).click();
  const instruction = page.locator(".composer__instruction");
  await instruction.fill("Rewrite");
  await instruction.press("Enter");
  await page.evaluate(() =>
    window.__COMPOSER_HOST__.emit("transform-delta", {
      mode: "custom",
      delta: "partial",
    }),
  );
  await expect(page.locator(".composer__input")).toHaveValue("partial");
  await instruction.press("Escape");
  await expect(page.locator(".composer__input")).toHaveValue(draft.trim());
  await expect(instruction).toHaveValue("Rewrite");
  expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(
    false,
  );
  expect(
    await page.evaluate(
      () =>
        window.__COMPOSER_HOST__.calls.filter(
          ({ command }) => command === "cancel_transform",
        ).length,
    ),
  ).toBe(1);
});

test("native edit undo and redo stay separate from revision navigation", async ({
  page,
}) => {
  const draft = await confirmDraft(page);
  await page.locator(".composer__mode").filter({ hasText: "Polish" }).click();
  await page.evaluate(() =>
    window.__COMPOSER_HOST__.emit("transform-done", {
      mode: "polish",
      text: "result",
    }),
  );
  const editor = page.locator(".composer__input");
  await expect(editor).toBeEditable();
  await editor.focus();
  await editor.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(element.value.length, element.value.length),
  );
  await page.keyboard.type(" suffix");
  await expect(editor).toHaveValue("result suffix");
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(editor).toHaveValue("result");
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(editor).toHaveValue("result suffix");
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(editor).toHaveValue(draft);
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect(editor).toHaveValue("result suffix");
});

for (const field of ["text", "instruction"] as const) {
  test(`${field} composition defers entry switch without losing focus or raw keys`, async ({
    page,
  }) => {
    const draft = await confirmDraft(page);
    await page.locator(".composer__mode").filter({ hasText: "Custom" }).click();
    await leaveChunk(page);
    await page.getByRole("button", { name: "Edit text", exact: true }).click();
    const editor = page.locator(".composer__input");
    const composing = page.locator(
      field === "text" ? ".composer__input" : ".composer__instruction",
    );
    await composing.focus();
    await composing.dispatchEvent("compositionstart", { data: "ㄱ" });
    await page
      .getByRole("button", { name: "Bilingual input", exact: true })
      .click();
    await expect(composing).toBeFocused();
    await expect(editor).toBeEditable();
    await composing.evaluate(
      (element: HTMLInputElement | HTMLTextAreaElement) => {
        element.value += "가";
        element.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "가" }),
        );
      },
    );
    await expect(editor).not.toBeEditable();
    await expect(editor).toHaveValue(field === "text" ? `${draft}가` : draft);
    await expect(page.locator(".composer__dual-text").nth(1)).toHaveText("rk");
    await editor.press("2");
    await expect(editor).toHaveValue(
      field === "text" ? `${draft}가 rk ` : `${draft}rk `,
    );
  });
}

for (const field of ["text", "instruction"] as const) {
  test(`${field} composition drains a deferred transform exactly once with finalized input`, async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Edit text", exact: true }).click();
    const editor = page.locator(".composer__input");
    await editor.fill("draft");
    if (field === "instruction") {
      await page
        .locator(".composer__mode")
        .filter({ hasText: "Custom" })
        .click();
      await page.locator(".composer__instruction").fill("instruction");
    }
    const composing = page.locator(
      field === "text" ? ".composer__input" : ".composer__instruction",
    );
    await composing.focus();
    await composing.dispatchEvent("compositionstart", { data: "ㄱ" });
    // A synthetic activation avoids native focus/IME termination and exercises the deferred request path.
    if (field === "text") {
      await page
        .locator(".composer__mode")
        .filter({ hasText: "Polish" })
        .dispatchEvent("click");
    } else {
      await composing.dispatchEvent("keydown", { key: "Enter", code: "Enter" });
    }
    expect(
      await page.evaluate(() =>
        window.__COMPOSER_HOST__.calls.filter(
          ({ command }) => command === "run_transform",
        ),
      ),
    ).toEqual([]);
    await composing.evaluate(
      (element: HTMLInputElement | HTMLTextAreaElement) => {
        element.value += "가";
        element.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "가" }),
        );
      },
    );
    const requests = await page.evaluate(() =>
      window.__COMPOSER_HOST__.calls
        .filter(({ command }) => command === "run_transform")
        .map(({ args }) => args),
    );
    expect(requests).toEqual([
      field === "text"
        ? { mode: "polish", text: "draft가" }
        : { mode: "custom", text: "draft", instruction: "instruction가" },
    ]);
    await editor.dispatchEvent("compositionend", { data: "" });
    expect(
      await page.evaluate(
        () =>
          window.__COMPOSER_HOST__.calls.filter(
            ({ command }) => command === "run_transform",
          ).length,
      ),
    ).toBe(1);
  });
}

test("stream owns the readonly editor and composition cannot corrupt revisions", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const editor = page.locator(".composer__input");
  await editor.fill("original draft");
  await page.locator(".composer__mode").filter({ hasText: "Polish" }).click();
  await expect(editor).not.toBeEditable();
  await expect(
    page.locator(".composer__input-mode-btn").first(),
  ).toBeDisabled();
  await expect(page.locator(".composer__input-mode-btn").nth(1)).toBeDisabled();
  await page.evaluate(() =>
    window.__COMPOSER_HOST__.emit("transform-delta", {
      mode: "polish",
      delta: "partial",
    }),
  );
  await expect(editor).toHaveValue("partial");
  await page
    .getByRole("button", { name: "Bilingual input", exact: true })
    .dispatchEvent("click");
  await editor.focus();
  await page.keyboard.type("rk");
  await expect(page.locator(".composer__dual")).toHaveCount(0);
  await editor.dispatchEvent("compositionstart", { data: "ㄱ" });
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.value = "corrupt draft";
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "가" }),
    );
  });
  await page.evaluate(() =>
    window.__COMPOSER_HOST__.emit("transform-done", {
      mode: "polish",
      text: "final result",
    }),
  );
  await expect(editor).toHaveValue("final result");
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(editor).toHaveValue("original draft");
  await page.getByRole("button", { name: /^Redo/ }).click();
  await expect(editor).toHaveValue("final result");
});

test("deferred transform checks raw keys captured before the editor finishes composing", async ({
  page,
}) => {
  const draft = await confirmDraft(page);
  const editor = page.locator(".composer__input");
  await editor.dispatchEvent("compositionstart", { data: "" });
  await page
    .locator(".composer__mode")
    .filter({ hasText: "Polish" })
    .dispatchEvent("click");
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "r",
        code: "KeyR",
      }),
    );
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "k",
        code: "KeyK",
      }),
    );
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "" }),
    );
  });
  await expect(editor).toHaveValue(draft);
  await expect(page.locator(".composer__dual-text").nth(1)).toHaveText("rk");
  await expect(page.getByRole("alert")).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.__COMPOSER_HOST__.calls.filter(
        ({ command }) => command === "run_transform",
      ),
    ),
  ).toEqual([]);
});

test("fresh session clears raw keys and deferred composition requests", async ({
  page,
}) => {
  await confirmDraft(page);
  const editor = page.locator(".composer__input");
  await editor.dispatchEvent("compositionstart", { data: "" });
  await page
    .locator(".composer__mode")
    .filter({ hasText: "Polish" })
    .dispatchEvent("click");
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  await editor.evaluate((element: HTMLTextAreaElement) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "r",
        code: "KeyR",
      }),
    );
  });
  await expect(page.locator(".composer__dual-text").nth(1)).toHaveText("r");
  await page.evaluate(() =>
    window.__COMPOSER_HOST__.emit("composer-open", null),
  );
  await expect(editor).toHaveValue("");
  await expect(editor).not.toBeEditable();
  await expect(page.locator(".composer__dual")).toHaveCount(0);
  await editor.dispatchEvent("compositionend", { data: "" });
  await expect(editor).not.toBeEditable();
  expect(
    await page.evaluate(() =>
      window.__COMPOSER_HOST__.calls.filter(
        ({ command }) => command === "run_transform",
      ),
    ),
  ).toEqual([]);
});

test("edit-mode Ctrl+Y is not intercepted as revision redo", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Edit text", exact: true }).click();
  const editor = page.locator(".composer__input");
  await editor.fill("native history");
  const handled = await editor.evaluate((element: HTMLTextAreaElement) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "y",
      code: "KeyY",
      ctrlKey: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(handled).toBe(false);
  await expect(editor).toHaveValue("native history");
});

for (const field of ["text", "instruction"] as const) {
  test(`${field} commit respects native IME metadata even without compositionstart`, async ({
    page,
  }) => {
    const draft = await confirmDraft(page);
    if (field === "instruction") {
      await page
        .locator(".composer__mode")
        .filter({ hasText: "Custom" })
        .click();
    }
    const focused = page.locator(
      field === "text" ? ".composer__input" : ".composer__instruction",
    );
    await focused.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    await focused.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      metaKey: true,
      keyCode: 229,
    });
    expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(
      false,
    );
    expect(
      await page.evaluate(() =>
        window.__COMPOSER_HOST__.calls.filter(
          ({ command }) => command === "run_transform",
        ),
      ),
    ).toEqual([]);
    await focused.press("Control+Enter");
    expect(
      await page.evaluate(() =>
        window.__COMPOSER_HOST__.calls
          .filter(({ command }) => command === "commit_composer")
          .map(({ args }) => args.text),
      ),
    ).toEqual([draft]);
  });
}

test("instruction composition started during streaming still blocks commit after completion", async ({
  page,
}) => {
  await confirmDraft(page);
  await page.locator(".composer__mode").filter({ hasText: "Custom" }).click();
  const instruction = page.locator(".composer__instruction");
  await instruction.fill("Rewrite");
  await instruction.press("Enter");
  await instruction.dispatchEvent("compositionstart", { data: "ㄱ" });
  await page.evaluate(() =>
    window.__COMPOSER_HOST__.emit("transform-done", {
      mode: "custom",
      text: "completed result",
    }),
  );
  await instruction.press("Control+Enter");
  expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(
    false,
  );
  await instruction.evaluate((element: HTMLInputElement) => {
    element.value += "가";
    element.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "가" }),
    );
  });
  expect(await page.evaluate(() => window.__COMPOSER_HOST__.closed)).toBe(
    false,
  );
  await instruction.press("Control+Enter");
  expect(
    await page.evaluate(() =>
      window.__COMPOSER_HOST__.calls
        .filter(({ command }) => command === "commit_composer")
        .map(({ args }) => args.text),
    ),
  ).toEqual(["completed result"]);
});
