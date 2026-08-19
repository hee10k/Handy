import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { locale } from "@tauri-apps/plugin-os";
import {
  getLanguageDirection,
  updateDocumentDirection,
  updateDocumentLanguage,
} from "@/lib/utils/rtl";

// The composer is a separate always-on-top window (own vite entry), so it gets
// its own i18next instance. It shares the exact same locale files as the main
// app (below) and mirrors src/i18n/index.ts' setup, but talks to the backend
// through raw `invoke` to stay decoupled from the generated `src/bindings.ts`.
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "../i18n/locales/*/translation.json",
  { eager: true },
);

const resources: Record<string, { translation: Record<string, unknown> }> = {};
for (const [path, module] of Object.entries(localeModules)) {
  const langCode = path.match(/\.\/\.\.\/i18n\/locales\/(.+)\/translation\.json/)?.[1];
  if (langCode) {
    resources[langCode] = { translation: module.default };
  }
}

const SUPPORTED_LANGUAGES = Object.keys(resources);

// Minimal language resolution mirroring src/i18n/index.ts getSupportedLanguage.
// Kept local so the composer never imports the bindings-coupled shared module.
const getSupportedLanguage = (
  langCode: string | null | undefined,
): string | null => {
  if (!langCode) return null;
  const normalized = langCode.toLowerCase().replace(/_/g, "-");
  const subtags = normalized.split("-");
  const language = subtags[0];
  const isHant = subtags.includes("hant");
  const isHans = subtags.includes("hans");
  const isTraditionalRegion = ["tw", "hk", "mo"].some((region) =>
    subtags.includes(region),
  );

  let supported = SUPPORTED_LANGUAGES.find(
    (code) => code.toLowerCase() === normalized,
  );
  if (!supported) {
    let fallback = language;
    if (language === "zh" && (isHant || (!isHans && isTraditionalRegion))) {
      fallback = "zh-TW";
    } else if (language === "yue") {
      fallback = isHans ? "zh" : "zh-TW";
    }
    supported = SUPPORTED_LANGUAGES.find(
      (code) => code.toLowerCase() === fallback,
    );
  }
  return supported ?? null;
};

// English default; unsupported/untouched locales fall back to en.
i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false, // React already escapes values
  },
  react: {
    useSuspense: false,
  },
});

// Sync the composer's language from app settings (raw invoke), falling back to
// the OS locale when no saved preference exists — same behaviour as the main app.
const syncLanguageFromSettings = async () => {
  try {
    const result = await invoke<{
      status: string;
      data?: { app_language?: string | null };
    }>("get_app_settings");
    if (result.status === "ok" && result.data?.app_language) {
      const supported = getSupportedLanguage(result.data.app_language);
      if (supported && supported !== i18n.language) {
        await i18n.changeLanguage(supported);
      }
      return;
    }
  } catch (e) {
    console.warn("Failed to sync composer language from settings:", e);
  }
  try {
    const systemLocale = await locale();
    const supported = getSupportedLanguage(systemLocale);
    if (supported && supported !== i18n.language) {
      await i18n.changeLanguage(supported);
    }
  } catch (e) {
    console.warn("Failed to detect system locale for composer:", e);
  }
};

void syncLanguageFromSettings();

// Keep the composer document's lang/dir in sync with the active language.
i18n.on("languageChanged", (lng) => {
  const dir = getLanguageDirection(lng);
  updateDocumentDirection(dir);
  updateDocumentLanguage(lng);
});

export default i18n;