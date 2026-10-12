import { test, expect, type Page } from "@playwright/test";

/**
 * Automatic bilingual input (ticket 13) — real components, mocked IPC bridge.
 *
 * These drive the shipped React components in a browser by emulating the Tauri
 * IPC bridge (`window.__TAURI_INTERNALS__`), so command names, event names and
 * payload shapes are exercised exactly as the webview does at runtime. The
 * backend behaviour itself is covered by Rust unit tests plus the live
 * `live_verdict_pipeline` test (real llama.cpp runtime + real GGUF model).
 */

interface MockModel {
  id: string;
  name: string;
  description: string;
  size_bytes: number;
  downloaded: boolean;
  downloading: boolean;
  downloaded_bytes: number;
  loaded: boolean;
  error: string | null;
}

const BASE_MODEL: MockModel = {
  id: "qwen3-0.6b-q8",
  name: "Qwen3 0.6B (Q8_0)",
  description: "Compact local model",
  size_bytes: 639446688,
  downloaded: false,
  downloading: false,
  downloaded_bytes: 0,
  loaded: false,
  error: null,
};

const IDLE_STATE = {
  enabled: false,
  selected_model: null,
  loading: false,
  loaded_model: null,
  error: null,
};

const LOADED_STATE = {
  enabled: true,
  selected_model: BASE_MODEL.id,
  loading: false,
  loaded_model: BASE_MODEL.id,
  error: null,
};

/** Serialized into the page: the whole IPC surface these components touch. */
function installTauriMock(config: {
  models: MockModel[];
  autoState: unknown;
  appLanguage?: string | null;
}) {
  type Handler = (event: {
    event: string;
    id: number;
    payload: unknown;
  }) => void;
  const state = {
    calls: [] as { cmd: string; args: Record<string, unknown> }[],
    models: config.models,
    autoState: config.autoState,
    listeners: new Map<string, { id: number; handler: Handler }[]>(),
    resolveCalls: [] as { context: string; spans: unknown[] }[],
  };
  const callbacks = new Map<number, Handler>();
  let nextId = 1;

  // The Tauri bridge and mock bag are injected by this script only.
  const bridge = window as Window & {
    __TAURI_INTERNALS__?: unknown;
    __MOCK__?: unknown;
  };
  bridge.__TAURI_INTERNALS__ = {
    transformCallback: (cb: Handler) => {
      const id = nextId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (path: string) => path,
    invoke: async (cmd: string, args: Record<string, unknown>) => {
      state.calls.push({ cmd, args });
      switch (cmd) {
        case "plugin:event|listen": {
          const name = String(args.event);
          const handler = callbacks.get(Number(args.handler));
          const list = state.listeners.get(name) ?? [];
          list.push({ id: nextId++, handler: handler as Handler });
          state.listeners.set(name, list);
          return nextId;
        }
        case "plugin:event|unlisten":
          return null;
        case "plugin:os|locale":
          return "en";
        case "get_auto_input_models":
          return state.models;
        case "get_auto_input_state":
          return state.autoState;
        case "list_transform_modes":
          return [
            {
              id: "polish",
              name: "Polish",
              description: "",
              takes_instruction: false,
            },
          ];
        case "get_quick_action_slots":
          return [];
        case "get_transform_settings":
        case "get_settings":
          return {};
        case "get_app_settings":
          return { app_language: config.appLanguage ?? null };
        case "resolve_auto_input": {
          const spans = (args.spans ?? []) as {
            id: number;
            ko: string;
            en: string;
          }[];
          state.resolveCalls.push({
            context: String(args.context ?? ""),
            spans,
          });
          const settled = Promise.withResolvers<void>();
          setTimeout(settled.resolve, 40);
          await settled.promise;
          // Mirrors the measured resolver: a dictionary-known candidate wins.
          const enWords = new Set(["meeting", "react", "today", "hello"]);
          return spans.map((span) => ({
            id: span.id,
            language: enWords.has(span.en.toLowerCase()) ? "en" : "ko",
          }));
        }
        default:
          return null;
      }
    },
  };

  bridge.__MOCK__ = {
    calls: () => state.calls,
    resetCalls: () => {
      state.calls = [];
    },
    setModels: (models: MockModel[]) => {
      state.models = models;
    },
    setAutoState: (next: unknown) => {
      state.autoState = next;
    },
    emit: (name: string, payload: unknown) => {
      for (const listener of state.listeners.get(name) ?? []) {
        listener.handler({ event: name, id: listener.id, payload });
      }
    },
    listeners: () => [...state.listeners.keys()],
    resolveCalls: () => state.resolveCalls,
  };
}

type MockHandle = {
  calls: () => { cmd: string; args: Record<string, unknown> }[];
  resetCalls: () => void;
  setModels: (models: MockModel[]) => void;
  setAutoState: (next: unknown) => void;
  emit: (name: string, payload: unknown) => void;
  listeners: () => string[];
  resolveCalls: () => { context: string; spans: unknown[] }[];
};

/** Event delivery is only meaningful once the component registered its listeners. */
const awaitListener = async (page: Page, name: string) => {
  await expect
    .poll(async () =>
      (await callMock<string[]>(page, "listeners")).includes(name),
    )
    .toBe(true);
};

const callMock = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ({ name, args: fnArgs }) => {
      const holder = window as Window & {
        __MOCK__?: Record<string, (...rest: unknown[]) => unknown>;
      };
      const target = holder.__MOCK__?.[name];
      if (typeof target !== "function") {
        throw new Error(`mock helper ${name} is not installed`);
      }
      return target(...fnArgs);
    },
    { name: fn, args },
  ) as Promise<T>;

test.describe("automatic bilingual input — settings panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installTauriMock, {
      models: [{ ...BASE_MODEL }],
      autoState: IDLE_STATE,
      appLanguage: null,
    });
    await page.goto("/tests/fixtures/auto-input/index.html");
    await expect(page.getByText("Automatic Bilingual Input")).toBeVisible();
  });

  test("downloads, cancels, loads and deletes through the generated bindings", async ({
    page,
  }) => {
    const calls = () =>
      callMock<{ cmd: string; args: Record<string, unknown> }[]>(page, "calls");

    await awaitListener(page, "auto-input-models-changed-payload");
    await expect(page.getByText("Not downloaded yet")).toBeVisible();
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await expect
      .poll(async () =>
        (await calls()).some(
          (call) =>
            call.cmd === "download_auto_input_model" &&
            call.args.modelId === BASE_MODEL.id,
        ),
      )
      .toBe(true);

    // Live progress arrives as an event, not as a command response.
    await callMock(page, "setModels", [
      { ...BASE_MODEL, downloading: true, downloaded_bytes: 40 },
    ]);
    await callMock(page, "emit", "auto-input-models-changed-payload", {});
    await callMock(page, "emit", "auto-input-model-progress-payload", {
      model_id: BASE_MODEL.id,
      phase: "model",
      downloaded: 40,
      total: 100,
    });
    await expect(page.getByText("Downloading… 40%")).toBeVisible();

    await callMock(page, "resetCalls");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect
      .poll(async () =>
        (await calls()).some(
          (call) => call.cmd === "cancel_auto_input_model_download",
        ),
      )
      .toBe(true);

    await callMock(page, "setModels", [{ ...BASE_MODEL, downloaded: true }]);
    await callMock(page, "emit", "auto-input-models-changed-payload", {});
    await expect(
      page.getByRole("button", { name: "Load", exact: true }),
    ).toBeVisible();

    await callMock(page, "resetCalls");
    await page.getByRole("button", { name: "Load", exact: true }).click();
    await expect
      .poll(async () =>
        (await calls()).some(
          (call) =>
            call.cmd === "set_auto_input_model" &&
            call.args.modelId === BASE_MODEL.id,
        ),
      )
      .toBe(true);

    await callMock(
      page,
      "emit",
      "auto-input-model-state-payload",
      LOADED_STATE,
    );
    await expect(page.getByText("Loaded", { exact: true })).toBeVisible();

    await callMock(page, "resetCalls");
    await page.getByRole("button", { name: "Unload", exact: true }).click();
    await expect
      .poll(async () =>
        (await calls()).some(
          (call) =>
            call.cmd === "set_auto_input_model" && call.args.modelId === null,
        ),
      )
      .toBe(true);

    await callMock(page, "resetCalls");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect
      .poll(async () =>
        (await calls()).some(
          (call) =>
            call.cmd === "delete_auto_input_model" &&
            call.args.modelId === BASE_MODEL.id,
        ),
      )
      .toBe(true);
  });

  test("enabling and backend errors reach the panel", async ({ page }) => {
    await awaitListener(page, "auto-input-model-state-payload");
    await page.locator('input[type="checkbox"]').first().click();
    await expect
      .poll(async () =>
        (await callMock<{ cmd: string }[]>(page, "calls")).some(
          (call) => call.cmd === "set_auto_input_enabled",
        ),
      )
      .toBe(true);

    await callMock(page, "emit", "auto-input-model-state-payload", {
      ...LOADED_STATE,
      loaded_model: null,
      error: "runtime install failed",
    });
    await expect(page.getByText("runtime install failed")).toBeVisible();
  });
});

test.describe("automatic bilingual input — composer", () => {
  const openComposer = async (
    page: Page,
    appLanguage: string | null = null,
  ) => {
    await page.addInitScript(installTauriMock, {
      models: [{ ...BASE_MODEL, downloaded: true }],
      autoState: LOADED_STATE,
      appLanguage,
    });
    await page.goto("/src/composer/index.html");
    await expect(page.locator("textarea").first()).toBeVisible();
    await awaitListener(page, "auto-input-model-state-payload");
    await callMock(
      page,
      "emit",
      "auto-input-model-state-payload",
      LOADED_STATE,
    );
  };

  test("renders translations and follows the saved app language", async ({
    page,
  }) => {
    await openComposer(page, "ko");
    const textarea = page.locator("textarea").first();
    await textarea.click();
    for (const key of ["KeyD", "KeyH", "KeyS", "KeyM", "KeyF", "Space"]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(40);
    }
    // The composer is its own window/i18next instance: it must load the shared
    // bundles (not raw keys) and honour the saved app language over the OS one.
    await expect(
      page.getByRole("region", { name: "해석된 단어 및 언어 전환" }),
    ).toBeVisible();
  });

  test("resolves typed words without a language switch and pins overrides", async ({
    page,
  }) => {
    await openComposer(page);
    const textarea = page.locator("textarea").first();
    await textarea.click();

    // Physical key codes: "dhsmf" → 오늘, "meeting" stays English. Real typing
    // speed keeps the single-flight resolver pipeline ordered.
    const typeWord = async (keys: string[]) => {
      for (const key of keys) {
        await page.keyboard.press(key);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(500);
    };
    await typeWord(["KeyD", "KeyH", "KeyS", "KeyM", "KeyF", "Space"]);
    await typeWord([
      "KeyM",
      "KeyE",
      "KeyE",
      "KeyT",
      "KeyI",
      "KeyN",
      "KeyG",
      "Space",
    ]);

    await expect(textarea).toHaveValue("오늘 meeting ");
    const spans = page.getByRole("region", {
      name: /Resolved words/,
    });
    await expect(spans).toContainText("오늘");
    await expect(spans).toContainText("KO");
    await expect(spans).toContainText("meeting");
    await expect(spans).toContainText("EN");

    // The second request carries the first word as context: rolling history,
    // and only the newly typed span is re-asked.
    const requests = await callMock<
      { context: string; spans: { id: number }[] }[]
    >(page, "resolveCalls");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests[1].context).toBe("오늘");
    expect(requests[1].spans.length).toBe(1);

    // A manual flip sticks: the resolved word keeps the override.
    await spans.getByRole("button", { name: /오늘/ }).click();
    await expect(textarea).toHaveValue("dhsmf meeting ");
    await expect(spans).toContainText("dhsmf");
  });
});
