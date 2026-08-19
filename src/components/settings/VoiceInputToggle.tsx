import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface VoiceInputToggleProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/**
 * Input-source toggle for voice (speech) input. Defaults to OFF so first-run
 * and onboarding are composer-first (ADR 3): with it off, the app never
 * requests microphone permission or drives a speech-model download. Turning it
 * on re-exposes the existing audio pipeline (microphone / model settings).
 */
export const VoiceInputToggle: React.FC<VoiceInputToggleProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const voiceInputEnabled = getSetting("voice_input_enabled") ?? false;

    return (
      <ToggleSwitch
        checked={voiceInputEnabled}
        onChange={(enabled) => updateSetting("voice_input_enabled", enabled)}
        isUpdating={isUpdating("voice_input_enabled")}
        label={t("settings.transform.inputSource.voiceInput.label")}
        description={t(
          "settings.transform.inputSource.voiceInput.description",
        )}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);

VoiceInputToggle.displayName = "VoiceInputToggle";