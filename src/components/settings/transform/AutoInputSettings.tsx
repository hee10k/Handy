import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { SettingContainer } from "@/components/ui/SettingContainer";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";
import Badge from "@/components/ui/Badge";
import ProgressBar from "@/components/shared/ProgressBar";
import { Check } from "lucide-react";
import { formatModelSize } from "@/lib/utils/format";
import { useAutoInputSettings } from "./useAutoInputSettings";

export const AutoInputSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    models,
    state,
    targetModelId,
    loadedModelId,
    isLoading,
    isUpdating,
    downloadProgress,
    commandError,
    handleToggleEnabled,
    handleBrowseModel,
    handleLoadModel,
    handleDownloadModel,
    handleCancelDownload,
    handleDeleteModel,
  } = useAutoInputSettings();

  const targetModel = useMemo(() => {
    return models.find((m) => m.id === targetModelId) ?? null;
  }, [models, targetModelId]);

  const modelOptions = useMemo(() => {
    return models.map((m) => {
      const sizeStr = formatModelSize(m.size_bytes / (1024 * 1024));
      const statusSuffix = m.downloaded
        ? ` (${sizeStr} - ${t("settings.transform.autoInput.model.downloaded")})`
        : ` (${sizeStr})`;
      return {
        value: m.id,
        label: `${m.name}${statusSuffix}`,
      };
    });
  }, [models, t]);

  const activeProgress = targetModel
    ? (downloadProgress[targetModel.id] ??
      (targetModel.downloading
        ? {
            downloaded: targetModel.downloaded_bytes,
            total: targetModel.size_bytes,
          }
        : undefined))
    : undefined;

  const isDownloading =
    targetModel?.downloading ||
    (!targetModel?.downloaded && activeProgress !== undefined);

  const downloadPercentage = useMemo(() => {
    if (!activeProgress || !targetModel) return 0;
    const total = activeProgress.total || targetModel.size_bytes || 1;
    return Math.min(
      100,
      Math.max(0, Math.round((activeProgress.downloaded / total) * 100)),
    );
  }, [activeProgress, targetModel]);

  const activeError = commandError || state.error || targetModel?.error || null;

  return (
    <>
      <ToggleSwitch
        label={t("settings.transform.autoInput.enable.label")}
        description={t("settings.transform.autoInput.enable.description")}
        checked={state.enabled}
        onChange={handleToggleEnabled}
        disabled={isLoading || isUpdating}
        isUpdating={isUpdating}
        grouped={true}
      />

      <SettingContainer
        title={t("settings.transform.autoInput.model.label")}
        description={t("settings.transform.autoInput.model.description")}
        descriptionMode="tooltip"
        layout="stacked"
        grouped={true}
      >
        <div className="flex flex-col gap-3 w-full">
          <Select
            value={targetModelId}
            options={modelOptions}
            onChange={handleBrowseModel}
            placeholder={t("settings.transform.autoInput.model.placeholder")}
            disabled={isLoading || isUpdating}
            isLoading={isLoading}
            isClearable={false}
            className="w-full min-w-[380px]"
          />
          {loadedModelId && loadedModelId !== targetModelId && (
            <Button
              variant="secondary"
              size="sm"
              disabled={isUpdating || state.loading}
              onClick={() => handleLoadModel(null)}
            >
              {t("settings.transform.autoInput.model.unload")}
            </Button>
          )}

          {targetModel && (
            <div className="flex flex-col gap-2 p-3 rounded-lg border border-mid-gray/20 bg-mid-gray/5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-text">
                  {targetModel.name}
                </span>
                <div className="flex items-center gap-2">
                  {state.loading && (
                    <Badge variant="secondary">
                      {t("settings.transform.autoInput.model.statusLoading")}
                    </Badge>
                  )}
                  {targetModel.downloaded &&
                    (loadedModelId === targetModel.id ? (
                      <Badge variant="success">
                        {t("settings.transform.autoInput.model.statusLoaded")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary">
                        {t("settings.transform.autoInput.model.statusUnloaded")}
                      </Badge>
                    ))}
                  <span className="text-xs text-text/60">
                    {t("settings.transform.autoInput.model.size", {
                      size: formatModelSize(
                        targetModel.size_bytes / (1024 * 1024),
                      ),
                    })}
                  </span>
                </div>
              </div>

              {targetModel.description && (
                <p className="text-xs text-text/70">
                  {targetModel.description}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-mid-gray/10">
                {isDownloading ? (
                  <div className="flex items-center justify-between w-full gap-3">
                    <ProgressBar
                      progress={[
                        {
                          id: targetModel.id,
                          percentage: downloadPercentage,
                          label: t(
                            "settings.transform.autoInput.model.downloading",
                            { progress: downloadPercentage },
                          ),
                        },
                      ]}
                      showLabel={true}
                      className="flex-1"
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleCancelDownload(targetModel.id)}
                    >
                      {t("settings.transform.autoInput.model.cancelDownload")}
                    </Button>
                  </div>
                ) : targetModel.downloaded ? (
                  <div className="flex items-center justify-between w-full">
                    <span className="flex items-center gap-1.5 text-xs text-green-400 font-medium">
                      <Check className="w-3.5 h-3.5" />
                      {t("settings.transform.autoInput.model.downloaded")}
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isUpdating || state.loading}
                      onClick={() =>
                        handleLoadModel(
                          loadedModelId === targetModel.id
                            ? null
                            : targetModel.id,
                        )
                      }
                    >
                      {t(
                        loadedModelId === targetModel.id
                          ? "settings.transform.autoInput.model.unload"
                          : "settings.transform.autoInput.model.load",
                      )}
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      disabled={isUpdating}
                      onClick={() => handleDeleteModel(targetModel.id)}
                    >
                      {t("settings.transform.autoInput.model.delete")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between w-full">
                    <span className="text-xs text-text/50">
                      {t("settings.transform.autoInput.model.notDownloaded")}
                    </span>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={isUpdating}
                      onClick={() => handleDownloadModel(targetModel.id)}
                    >
                      {t("settings.transform.autoInput.model.download")}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </SettingContainer>

      {activeError && (
        <Alert variant="error" contained>
          {t("settings.transform.autoInput.model.error", {
            error: activeError,
          })}
        </Alert>
      )}
    </>
  );
};

AutoInputSettings.displayName = "AutoInputSettings";
export default AutoInputSettings;
