import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "../../../hooks/useSettings";
import { useSettingsStore } from "../../../stores/settingsStore";
import type { PostProcessProvider } from "@/bindings";
import type { ModelOption } from "../PostProcessingSettingsApi/types";
import type { DropdownOption } from "../../ui/Dropdown";

const APPLE_PROVIDER_ID = "apple_intelligence";

type TransformProviderSettingsState = {
  providerOptions: DropdownOption[];
  selectedProviderId: string;
  selectedProvider: PostProcessProvider | undefined;
  isCustomProvider: boolean;
  isAppleProvider: boolean;
  appleIntelligenceUnavailable: boolean;
  baseUrl: string;
  handleBaseUrlChange: (value: string) => void;
  isBaseUrlUpdating: boolean;
  apiKey: string;
  handleApiKeyChange: (value: string) => void;
  isApiKeyUpdating: boolean;
  model: string;
  handleModelChange: (value: string) => void;
  modelOptions: ModelOption[];
  isModelUpdating: boolean;
  isFetchingModels: boolean;
  handleProviderSelect: (providerId: string) => void;
  handleModelSelect: (value: string) => void;
  handleModelCreate: (value: string) => void;
  handleRefreshModels: () => void;
};

/**
 * Provider/model/api-key state for the TAJAGI transform provider config.
 *
 * Transform reuses the existing `post_process_*` settings schema (ADR 4), so
 * this reads providers/models/keys directly off the settings object. Writes go
 * through the ticket-03 transform commands (`get/set_transform_provider`,
 * `get/set_transform_model`, `fetch_transform_models`, `get/set_transform_api_key`)
 * via raw `invoke`, keeping us decoupled from the shared specta bindings.
 *
 * The one gap in the transform command surface is editing the custom
 * provider's base URL; that is persisted through the existing
 * `change_post_process_base_url_setting` command (same underlying settings).
 */
export const useTransformProviderSettings =
  (): TransformProviderSettingsState => {
    const { settings, isUpdating, refreshSettings } = useSettings();
    const postProcessModelOptions = useSettingsStore(
      (state) => state.postProcessModelOptions,
    );
    const setPostProcessModelOptions = useSettingsStore(
      (state) => state.setPostProcessModelOptions,
    );
    const [appleIntelligenceUnavailable, setAppleIntelligenceUnavailable] =
      useState(false);

    // Settings are guaranteed to have providers after migration
    const providers = settings?.post_process_providers || [];

    const selectedProviderId = useMemo(() => {
      return (
        settings?.post_process_provider_id || providers[0]?.id || "openai"
      );
    }, [providers, settings?.post_process_provider_id]);

    const selectedProvider = useMemo(() => {
      return (
        providers.find((provider) => provider.id === selectedProviderId) ||
        providers[0]
      );
    }, [providers, selectedProviderId]);

    const isAppleProvider = selectedProvider?.id === APPLE_PROVIDER_ID;
    const baseUrl = selectedProvider?.base_url ?? "";
    const apiKey = settings?.post_process_api_keys?.[selectedProviderId] ?? "";
    const model = settings?.post_process_models?.[selectedProviderId] ?? "";

    const providerOptions = useMemo<DropdownOption[]>(() => {
      return providers.map((provider) => ({
        value: provider.id,
        label: provider.label,
      }));
    }, [providers]);

    const fetchTransformModels = useCallback(
      async (providerId: string) => {
        const models = await invoke<string[]>("fetch_transform_models", {
          providerId,
        }).catch((err) => {
          console.error("Failed to fetch transform models:", err);
          return [] as string[];
        });
        setPostProcessModelOptions(providerId, models);
        return models;
      },
      [setPostProcessModelOptions],
    );

    const handleProviderSelect = useCallback(
      async (providerId: string) => {
        setAppleIntelligenceUnavailable(false);
        if (providerId === selectedProviderId) return;

        if (providerId === APPLE_PROVIDER_ID) {
          const available = await invoke<boolean>(
            "check_apple_intelligence_available",
          ).catch(() => false);
          if (!available) setAppleIntelligenceUnavailable(true);
        }

        await invoke("set_transform_provider", { providerId });
        await refreshSettings();

        // Auto-fetch available models so the dropdown reflects what's valid
        // for the newly selected provider. Skip when it isn't configured yet.
        if (providerId !== APPLE_PROVIDER_ID) {
          const provider = providers.find((p) => p.id === providerId);
          const pApiKey = settings?.post_process_api_keys?.[providerId] ?? "";
          const hasBaseUrl = (provider?.base_url ?? "").trim() !== "";
          if (provider?.id === "custom" ? hasBaseUrl : pApiKey.trim() !== "") {
            void fetchTransformModels(providerId);
          }
        }
      },
      [
        selectedProviderId,
        providers,
        settings,
        refreshSettings,
        fetchTransformModels,
      ],
    );

    const handleBaseUrlChange = useCallback(
      (value: string) => {
        if (!selectedProvider || selectedProvider.id !== "custom") return;
        const trimmed = value.trim();
        if (trimmed && trimmed !== baseUrl) {
          void invoke("change_post_process_base_url_setting", {
            providerId: selectedProviderId,
            baseUrl: trimmed,
          })
            // Reset the stored model: the previous value is almost certainly
            // invalid for the new endpoint.
            .then(() =>
              invoke("set_transform_model", {
                providerId: selectedProviderId,
                model: "",
              }),
            )
            .then(() => refreshSettings())
            .catch((err) =>
              console.error("Failed to update transform base URL:", err),
            );
        }
      },
      [
        selectedProvider,
        selectedProviderId,
        baseUrl,
        refreshSettings,
      ],
    );

    const handleApiKeyChange = useCallback(
      (value: string) => {
        const trimmed = value.trim();
        if (trimmed !== apiKey) {
          void invoke("set_transform_api_key", {
            providerId: selectedProviderId,
            key: trimmed,
          })
            .then(() => refreshSettings())
            .catch((err) =>
              console.error("Failed to update transform API key:", err),
            );
        }
      },
      [apiKey, selectedProviderId, refreshSettings],
    );

    const handleModelChange = useCallback(
      (value: string) => {
        const trimmed = value.trim();
        if (trimmed !== model) {
          void invoke("set_transform_model", {
            providerId: selectedProviderId,
            model: trimmed,
          })
            .then(() => refreshSettings())
            .catch((err) =>
              console.error("Failed to update transform model:", err),
            );
        }
      },
      [model, selectedProviderId, refreshSettings],
    );

    const handleModelSelect = useCallback(
      (value: string) => {
        void handleModelChange(value);
      },
      [handleModelChange],
    );

    const handleModelCreate = useCallback(
      (value: string) => {
        void invoke("set_transform_model", {
          providerId: selectedProviderId,
          model: value,
        })
          .then(() => refreshSettings())
          .catch((err) =>
            console.error("Failed to create transform model:", err),
          );
      },
      [selectedProviderId, refreshSettings],
    );

    const handleRefreshModels = useCallback(() => {
      if (!isAppleProvider) void fetchTransformModels(selectedProviderId);
    }, [fetchTransformModels, isAppleProvider, selectedProviderId]);

    const availableModelsRaw =
      postProcessModelOptions[selectedProviderId] || [];

    const modelOptions = useMemo<ModelOption[]>(() => {
      const seen = new Set<string>();
      const options: ModelOption[] = [];
      const upsert = (value: string | null | undefined) => {
        const trimmed = value?.trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        options.push({ value: trimmed, label: trimmed });
      };
      for (const candidate of availableModelsRaw) upsert(candidate);
      upsert(model);
      return options;
    }, [availableModelsRaw, model]);

    const isBaseUrlUpdating = isUpdating(
      `post_process_base_url:${selectedProviderId}`,
    );
    const isApiKeyUpdating = isUpdating(
      `post_process_api_key:${selectedProviderId}`,
    );
    const isModelUpdating = isUpdating(
      `post_process_model:${selectedProviderId}`,
    );
    const isFetchingModels = isUpdating(
      `post_process_models_fetch:${selectedProviderId}`,
    );

    const isCustomProvider = selectedProvider?.id === "custom";

    return {
      providerOptions,
      selectedProviderId,
      selectedProvider,
      isCustomProvider,
      isAppleProvider,
      appleIntelligenceUnavailable,
      baseUrl,
      handleBaseUrlChange,
      isBaseUrlUpdating,
      apiKey,
      handleApiKeyChange,
      isApiKeyUpdating,
      model,
      handleModelChange,
      modelOptions,
      isModelUpdating,
      isFetchingModels,
      handleProviderSelect,
      handleModelSelect,
      handleModelCreate,
      handleRefreshModels,
    };
  };