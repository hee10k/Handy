import React from "react";
import { useTranslation } from "react-i18next";
import { RefreshCcw } from "lucide-react";

import { Alert } from "../../ui/Alert";
import {
  SettingContainer,
  SettingsGroup,
} from "@/components/ui";
import { ResetButton } from "../../ui/ResetButton";

import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { PostProcessingSettingsPrompts } from "../post-processing/PostProcessingSettings";

import { ShortcutInput } from "../ShortcutInput";
import { VoiceInputToggle } from "../VoiceInputToggle";
import { useTransformProviderSettings } from "./useTransformProviderSettings";

const TransformProviderConfig: React.FC = () => {
  const { t } = useTranslation();
  const state = useTransformProviderSettings();

  return (
    <>
      <SettingContainer
        title={t("settings.transform.provider.title")}
        description={t("settings.transform.provider.description")}
        descriptionMode="tooltip"
        layout="horizontal"
        grouped={true}
      >
        <div className="flex items-center gap-2">
          <ProviderSelect
            options={state.providerOptions}
            value={state.selectedProviderId}
            onChange={state.handleProviderSelect}
          />
        </div>
      </SettingContainer>

      {state.isAppleProvider ? (
        state.appleIntelligenceUnavailable ? (
          <Alert variant="error" contained>
            {t("settings.transform.provider.appleIntelligence.unavailable")}
          </Alert>
        ) : null
      ) : (
        <>
          {state.selectedProvider?.id === "custom" && (
            <SettingContainer
              title={t("settings.transform.provider.baseUrl.title")}
              description={t(
                "settings.transform.provider.baseUrl.description",
              )}
              descriptionMode="tooltip"
              layout="horizontal"
              grouped={true}
            >
              <div className="flex items-center gap-2">
                <BaseUrlField
                  value={state.baseUrl}
                  onBlur={state.handleBaseUrlChange}
                  placeholder={t(
                    "settings.transform.provider.baseUrl.placeholder",
                  )}
                  disabled={state.isBaseUrlUpdating}
                  className="min-w-[380px]"
                />
              </div>
            </SettingContainer>
          )}

          <SettingContainer
            title={t("settings.transform.provider.apiKey.title")}
            description={t("settings.transform.provider.apiKey.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <ApiKeyField
                value={state.apiKey}
                onBlur={state.handleApiKeyChange}
                placeholder={t("settings.transform.provider.apiKey.placeholder")}
                disabled={state.isApiKeyUpdating}
                className="min-w-[320px]"
              />
            </div>
          </SettingContainer>
        </>
      )}

      {!state.isAppleProvider && (
        <SettingContainer
          title={t("settings.transform.provider.model.title")}
          description={
            state.isCustomProvider
              ? t("settings.transform.provider.model.descriptionCustom")
              : t("settings.transform.provider.model.descriptionDefault")
          }
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <div className="flex items-center gap-2">
            <ModelSelect
              value={state.model}
              options={state.modelOptions}
              disabled={state.isModelUpdating}
              isLoading={state.isFetchingModels}
              placeholder={
                state.modelOptions.length > 0
                  ? t(
                      "settings.transform.provider.model.placeholderWithOptions",
                    )
                  : t(
                      "settings.transform.provider.model.placeholderNoOptions",
                    )
              }
              onSelect={state.handleModelSelect}
              onCreate={state.handleModelCreate}
              onBlur={() => {}}
              className="flex-1 min-w-[380px]"
            />
            <ResetButton
              onClick={state.handleRefreshModels}
              disabled={state.isFetchingModels}
              ariaLabel={t("settings.transform.provider.model.refreshModels")}
              className="flex h-10 w-10 items-center justify-center"
            >
              <RefreshCcw
                className={`h-4 w-4 ${state.isFetchingModels ? "animate-spin" : ""}`}
              />
            </ResetButton>
          </div>
        </SettingContainer>
      )}
    </>
  );
};

export const TransformSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <SettingsGroup title={t("settings.transform.inputSource.title")}>
        <VoiceInputToggle descriptionMode="tooltip" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.transform.shortcuts.title")}>
        <ShortcutInput shortcutId="composer_open" grouped={true} />
      </SettingsGroup>

      <SettingsGroup title={t("settings.transform.provider.titleGroup")}>
        <TransformProviderConfig />
      </SettingsGroup>

      <SettingsGroup title={t("settings.transform.instructions.title")}>
        <PostProcessingSettingsPrompts />
      </SettingsGroup>
    </div>
  );
};

TransformSettings.displayName = "TransformSettings";