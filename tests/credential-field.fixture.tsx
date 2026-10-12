import React, { useState } from "react";
import ReactDOM from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { useProviderCredential } from "@/hooks/useProviderCredential";
import { ApiKeyField } from "@/components/settings/PostProcessingSettingsApi/ApiKeyField";

/**
 * Browser harness for the provider credential field.
 *
 * It renders the real hook and the real field component against a stubbed Tauri
 * IPC boundary (`window.__TAURI_INTERNALS__.invoke`), the only seam available
 * outside the desktop shell. A test replaces `window.__credentialBackend.handlers`
 * before load (or later through `page.evaluate`) to control backend latency and
 * failures, then asserts what the user sees: the field text and the alert.
 */

type BackendHandler = (args: Record<string, unknown>) => unknown;

interface CredentialBackend {
  calls: Array<{ command: string; args: Record<string, unknown> }>;
  handlers: Record<string, BackendHandler>;
}

declare global {
  interface Window {
    __credentialBackend?: CredentialBackend;
    __TAURI_INTERNALS__?: {
      invoke: (command: string, args?: unknown) => Promise<unknown>;
      transformCallback: () => number;
      unregisterCallback: () => void;
      convertFileSrc: (path: string) => string;
    };
  }
}

// Per command defaults: no stored key, resolving writes, no retained migration.
if (!window.__credentialBackend) {
  window.__credentialBackend = {
    calls: [],
    handlers: {
      get_transform_api_key: () => null,
      set_transform_api_key: () => null,
      delete_transform_api_key: () => null,
      get_credential_status: () => ({ migration: null }),
    },
  };
}

if (!window.__TAURI_INTERNALS__) {
  window.__TAURI_INTERNALS__ = {
    invoke: async (command: string, args?: unknown) => {
      const backend = window.__credentialBackend!;
      const request = (args ?? {}) as Record<string, unknown>;
      backend.calls.push({ command, args: request });
      const handler = backend.handlers[command];
      return handler ? await handler(request) : null;
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    convertFileSrc: (path: string) => path,
  };
}

const Harness: React.FC = () => {
  const [providerId, setProviderId] = useState("openai");
  const credential = useProviderCredential(providerId);

  return (
    <div>
      <span data-testid="provider">{providerId}</span>
      <button
        type="button"
        onClick={() =>
          setProviderId((current) =>
            current === "openai" ? "anthropic" : "openai",
          )
        }
      >
        switch provider
      </button>
      <ApiKeyField
        value={credential.value}
        onChange={credential.setValue}
        onBlur={credential.commit}
        disabled={credential.isSaving}
        placeholder="sk-..."
        error={credential.error}
        migrationWarning={credential.migrationWarning}
      />
    </div>
  );
};

// Mirrors the English values delivered in the P0 locale payload; kept local so
// the fixture does not depend on the app's i18n bootstrap (which talks to the
// backend for the saved language).
void i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: {
          settings: {
            credentials: {
              apiKey: {
                loadFailed:
                  "Couldn't read the saved API key. Enter your key again to continue.",
                saveFailed:
                  "Couldn't save the API key. Check the key and try again.",
                deleteFailed: "Couldn't remove the API key. Try again.",
                migrationConflict:
                  "A different key is already stored for this provider. Enter your key here to replace it, or clear the field and leave it to remove the stored key.",
                migrationIncomplete:
                  "The key was saved, but the previous copy couldn't be removed. Enter the key again to finish, or clear the field and leave it to remove the stored key.",
                migrationFailed:
                  "Secure storage rejected the key. Enter it again to retry.",
              },
            },
          },
        },
      },
    },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  .then(() => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <Harness />,
    );
  });
