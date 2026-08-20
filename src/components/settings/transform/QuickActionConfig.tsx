import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Select } from "../../ui/Select";
import { SettingContainer } from "../../ui/SettingContainer";

// Mirrors the backend `TransformModeInfo` (ticket 03). Raw `invoke` keeps us
// decoupled from the generated `src/bindings.ts` (repo convention).
interface TransformModeInfo {
  id: string;
  name: string;
  description: string;
  takes_instruction: boolean;
}

interface QuickActionSlot {
  slot: number; // 1..10, maps to Cmd/Ctrl+1..0 in the composer
  mode: string; // transform mode id
}

const SLOT_COUNT = 10;

/**
 * Assign transform modes to the composer's 10 quick-action slots (ticket 09).
 * Slots 1-4 ship pre-filled (polish / translate_english / prompt_english /
 * custom); 5-10 start empty. An empty slot is hidden from the composer and
 * unbound from its Cmd/Ctrl+shortcut.
 */
export const QuickActionConfig: React.FC = () => {
  const { t } = useTranslation();
  const [modes, setModes] = useState<TransformModeInfo[]>([]);
  const [slots, setSlots] = useState<Record<number, string>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let disposed = false;
    void invoke<TransformModeInfo[]>("list_transform_modes")
      .then((m) => {
        if (!disposed) setModes(m);
      })
      .catch(() => {});
    void invoke<[number, string][]>("get_quick_action_slots")
      .then((pairs) => {
        if (disposed) return;
        const next: Record<number, string> = {};
        for (const [slot, mode] of pairs) next[slot] = mode;
        setSlots(next);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      disposed = true;
    };
  }, []);

  const modeOptions = useMemo(
    () => modes.map((m) => ({ value: m.id, label: m.name })),
    [modes],
  );

  const handleChange = (slot: number, value: string | null) => {
    // Optimistic update; the backend is authoritative and returns an error on
    // an invalid mode id.
    setSlots((prev) => {
      const next = { ...prev };
      if (value) next[slot] = value;
      else delete next[slot];
      return next;
    });
    void invoke("set_quick_action_slot", { slot, mode: value }).catch(() => {
      // Re-read to resync if the write failed.
      void invoke<[number, string][]>("get_quick_action_slots").then((pairs) => {
        const next: Record<number, string> = {};
        for (const [s, m] of pairs) next[s] = m;
        setSlots(next);
      });
    });
  };

  return (
    <SettingContainer
      title={t("settings.transform.quickActions.title")}
      description={t("settings.transform.quickActions.description")}
      descriptionMode="tooltip"
      layout="stacked"
      grouped={true}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {Array.from({ length: SLOT_COUNT }, (_, i) => i + 1).map((slot) => {
          const current = slots[slot];
          const assigned = current ?? null;
          return (
            <label
              key={slot}
              className="flex items-center gap-2 text-sm text-primary"
            >
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-muted text-xs text-muted-foreground">
                {slot === 10 ? "0" : String(slot)}
              </span>
              <Select
                value={assigned}
                options={modeOptions}
                isClearable
                disabled={!loaded}
                placeholder={t(
                  "settings.transform.quickActions.emptyPlaceholder",
                )}
                onChange={(value) => handleChange(slot, value)}
                className="flex-1"
              />
            </label>
          );
        })}
      </div>
    </SettingContainer>
  );
};

QuickActionConfig.displayName = "QuickActionConfig";