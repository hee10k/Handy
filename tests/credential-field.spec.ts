import { test, expect, type Page } from "@playwright/test";

/**
 * Credential-field regressions for the async edges the desktop smoke test cannot
 * reach deterministically: a provider switch while a key read is in flight, a
 * late read arriving after the user typed, and a failed blank commit. The
 * fixture renders the real hook and field against a stubbed Tauri IPC boundary;
 * assertions are on what the user sees (field text, alert text), not on wiring.
 */

declare global {
  interface Window {
    __credentialBackend?: {
      calls: Array<{ command: string; args: Record<string, unknown> }>;
      handlers: Record<string, (args: Record<string, unknown>) => unknown>;
    };
    __resolveKeyRead?: (key: string | null) => void;
    __resolveOpenAiRead?: () => void;
    __outcome?: string;
  }
}

const FIXTURE = "/tests/credential-field.fixture.html";

const fieldOf = (page: Page) => page.getByPlaceholder("sk-...");
const alertsOf = (page: Page) => page.locator('[role="alert"]');

test.describe("provider credential field", () => {
  test("a key read that lands after typing never overwrites the typed text", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const read = Promise.withResolvers<string | null>();
      window.__credentialBackend = {
        calls: [],
        handlers: {
          get_transform_api_key: () => read.promise,
          get_credential_status: () => ({ migration: null }),
        },
      };
      window.__resolveKeyRead = (key) => read.resolve(key);
    });

    await page.goto(FIXTURE);

    const field = fieldOf(page);
    // The stored key has not arrived yet, so the field is isolated and empty.
    await expect(field).toHaveValue("");
    await field.pressSequentially("typed-key");
    await expect(field).toHaveValue("typed-key");

    await page.evaluate(() => window.__resolveKeyRead?.("stored-key"));

    await expect(field).toHaveValue("typed-key");
    await expect(alertsOf(page)).toHaveCount(0);
  });

  test("switching providers isolates the field from the previous provider's read", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const openAiRead = Promise.withResolvers<string | null>();
      window.__credentialBackend = {
        calls: [],
        handlers: {
          get_transform_api_key: (args) =>
            args.providerId === "openai" ? openAiRead.promise : "anthropic-key",
          get_credential_status: () => ({ migration: null }),
        },
      };
      window.__resolveOpenAiRead = () => openAiRead.resolve("openai-key");
    });

    await page.goto(FIXTURE);

    const field = fieldOf(page);
    await expect(field).toHaveValue("");

    await page.getByRole("button", { name: "switch provider" }).click();
    await expect(page.getByTestId("provider")).toHaveText("anthropic");
    await expect(field).toHaveValue("anthropic-key");

    // The abandoned read for the previous provider must not reach this field.
    await page.evaluate(() => window.__resolveOpenAiRead?.());
    await expect(field).toHaveValue("anthropic-key");
  });

  test("clearing the field removes the key and a failed removal stays visible", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.__credentialBackend = {
        calls: [],
        handlers: {
          get_transform_api_key: () => "stored-key",
          set_transform_api_key: () => null,
          delete_transform_api_key: () => {
            throw new Error("keychain unavailable");
          },
          get_credential_status: () => ({ migration: null }),
        },
      };
    });

    await page.goto(FIXTURE);

    const field = fieldOf(page);
    await expect(field).toHaveValue("stored-key");

    await field.fill("");
    await field.blur();

    await expect(field).toHaveValue("");
    await expect(alertsOf(page)).toHaveCount(1);
    await expect(alertsOf(page)).toHaveText(
      "Couldn't remove the API key. Try again.",
    );
  });

  test("a retained migration conflict is shown once and clears when resolved", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.__outcome = "conflict";
      window.__credentialBackend = {
        calls: [],
        handlers: {
          get_transform_api_key: () => null,
          set_transform_api_key: () => null,
          delete_transform_api_key: () => null,
          get_credential_status: () => ({
            migration: { outcomes: { openai: window.__outcome } },
          }),
        },
      };
    });

    await page.goto(FIXTURE);

    const field = fieldOf(page);
    await expect(alertsOf(page)).toHaveCount(1);
    await expect(alertsOf(page)).toContainText(
      "A different key is already stored for this provider",
    );

    // Re-entering the key resolves the retained outcome on the backend.
    await page.evaluate(() => {
      window.__outcome = "migrated";
    });
    await field.pressSequentially("replacement-key");
    await field.blur();

    await expect(alertsOf(page)).toHaveCount(0);
    await expect(field).toHaveValue("replacement-key");
  });
});
