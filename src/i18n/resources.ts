// Shared i18n resources for every vite entry (settings window, composer,
// recording overlay). Locale files are bundled eagerly so both i18next
// instances initialize synchronously and agree on the same language set.

const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "./locales/*/translation.json",
  { eager: true },
);

// Tajagi ships ko + en only (soft-fork policy, per product decision). All other
// bundled locales are unreachable: the language dropdown offers ko/en and any
// non-ko/en system locale falls back to English. Keeping the upstream locale
// files on disk is harmless — they are filtered out here.
const APP_LANGUAGE_ALLOWLIST = ["en", "ko"];

/** Locale code → i18next `{ translation }` bundle, for the allowed locales. */
export const resources: Record<
  string,
  { translation: Record<string, unknown> }
> = {};
for (const [path, module] of Object.entries(localeModules)) {
  const segments = path.split("/");
  const langCode = segments[segments.length - 2];
  if (langCode && APP_LANGUAGE_ALLOWLIST.includes(langCode)) {
    resources[langCode] = { translation: module.default };
  }
}
