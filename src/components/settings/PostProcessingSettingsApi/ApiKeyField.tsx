import React from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Input } from "../../ui/Input";
import type {
  CredentialError,
  CredentialMigrationWarning,
} from "@/hooks/useProviderCredential";

interface ApiKeyFieldProps {
  /** Provider-tagged field text owned by the caller's credential state. */
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  disabled: boolean;
  placeholder?: string;
  className?: string;
  /** Failed credential operation to surface under the field. */
  error?: CredentialError | null;
  /** Retained migration outcome keeping the selected provider blocked. */
  migrationWarning?: CredentialMigrationWarning | null;
}

/**
 * Localized messages for the field's single alert. Indexed by the values the
 * backend DTO and the credential lifecycle produce; `migrated`/`skipped` and an
 * unreadable status produce no message, so the UI never claims a key is valid
 * just because storage was reachable.
 */
const WARNING_KEYS: Record<CredentialMigrationWarning, string> = {
  conflict: "settings.credentials.apiKey.migrationConflict",
  incomplete: "settings.credentials.apiKey.migrationIncomplete",
  failed: "settings.credentials.apiKey.migrationFailed",
};

const ERROR_KEYS: Record<CredentialError["operation"], string> = {
  load: "settings.credentials.apiKey.loadFailed",
  save: "settings.credentials.apiKey.saveFailed",
  delete: "settings.credentials.apiKey.deleteFailed",
};

/**
 * The API-key input for a provider. Deliberately controlled and stateless: the
 * text lives in the caller's credential state, so an async completion for
 * another provider can never overwrite what the user sees here. A retained
 * migration outcome wins over a bare operation failure — it is the actionable
 * state, and the failed read/write is its cause.
 */
export const ApiKeyField: React.FC<ApiKeyFieldProps> = React.memo(
  ({
    value,
    onChange,
    onBlur,
    disabled,
    placeholder,
    className = "",
    error,
    migrationWarning,
  }) => {
    const { t } = useTranslation();
    const alertMessage = migrationWarning
      ? t(WARNING_KEYS[migrationWarning])
      : error
        ? t(ERROR_KEYS[error.operation])
        : null;

    return (
      <div className="flex flex-col gap-1">
        <Input
          type="password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          variant="compact"
          disabled={disabled}
          className={`flex-1 min-w-[320px] ${className}`}
        />
        {alertMessage && (
          <div
            role="alert"
            className="flex items-start gap-2 text-sm text-warning"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{alertMessage}</span>
          </div>
        )}
      </div>
    );
  },
);

ApiKeyField.displayName = "ApiKeyField";
