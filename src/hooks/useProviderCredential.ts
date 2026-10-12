import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * One provider's API key, held for the settings UI.
 *
 * The backend keeps credentials in the OS native store (Linux: settings), so
 * this field is the only place a key value ever lives in the frontend. Reads use
 * `get_transform_api_key`, writes `set_transform_api_key`, and a field the user
 * explicitly blanks is removed with `delete_transform_api_key` — a blank commit
 * is a deletion, never an empty write. Nothing here touches AppSettings, the
 * Zustand store or localStorage, and no value is echoed to logs.
 *
 * Every read/write is addressed by the provider id captured when the operation
 * starts, and all field state is tagged with the provider it belongs to. A
 * completion that arrives for a previously selected provider therefore cannot
 * populate, overwrite, error or unblock the provider now on screen, and a
 * provider switch shows an empty field immediately rather than after a
 * post-paint effect. Keystrokes also invalidate pending reads, so a slow initial
 * read can never overwrite what the user has already typed or committed.
 */

/**
 * Retained migration outcome that keeps a provider blocked until it is resolved
 * by re-entering or removing the key. `migrated`/`skipped` are resolved states
 * and produce no warning.
 */
export type CredentialMigrationWarning = "conflict" | "incomplete" | "failed";

/** Credential operation that failed; drives the localized field message. */
export type CredentialErrorOperation = "load" | "save" | "delete";

export interface CredentialError {
  operation: CredentialErrorOperation;
  /**
   * Secret-free backend detail, kept for diagnostics. The UI renders the
   * localized message for `operation` only — raw backend text stays in the log,
   * matching the paste/transcription error handling in App.tsx.
   */
  detail: string;
}

export interface CredentialFieldState {
  /** Field text for the current provider; empty until its own read lands. */
  value: string;
  isSaving: boolean;
  error: CredentialError | null;
  migrationWarning: CredentialMigrationWarning | null;
  /** Called on every keystroke; cancels pending reads for this provider. */
  setValue: (value: string) => void;
  /** Called on blur; persists the typed value or deletes on a blank field. */
  commit: () => void;
}

/**
 * Backend DTO (raw invoke returns the command data, not a specta Result
 * envelope): MigrationOutcome is one of the snake_case variants or
 * `{ failed: string }`, and MigrationStatus holds one outcome per provider id.
 */
type RawMigrationOutcome = string | { failed: string };
interface RawCredentialStatus {
  migration: { outcomes: Record<string, RawMigrationOutcome> } | null;
}

interface FieldEntry {
  providerId: string;
  text: string;
  dirty: boolean;
}

/**
 * A raw invoke may reject, but a command still registered with the typed
 * Result envelope resolves to `{ status: "error" }` instead. Treat both as
 * failures so a rejected enforcement is never mistaken for success.
 */
const errorFromResolvedResult = (result: unknown): string | null => {
  if (result && typeof result === "object" && "status" in result) {
    const envelope = result as { status?: unknown; error?: unknown };
    if (envelope.status === "error") {
      return typeof envelope.error === "string" && envelope.error !== ""
        ? envelope.error
        : "Credential command failed";
    }
  }
  return null;
};

const parseMigrationWarning = (
  status: RawCredentialStatus | null | undefined,
  providerId: string,
): CredentialMigrationWarning | null => {
  const outcome = status?.migration?.outcomes?.[providerId];
  if (!outcome) return null;
  if (typeof outcome === "string") {
    return outcome === "conflict" || outcome === "incomplete" ? outcome : null;
  }
  return "failed";
};

/**
 * Read another provider's stored key for a decision that is not the credential
 * field itself (whether the newly selected provider has a key before its models
 * are fetched). Returns null when the read fails, so callers treat the key as
 * unavailable instead of assuming one exists.
 */
export const readProviderApiKey = async (
  providerId: string,
): Promise<string | null> => {
  try {
    const key = await invoke<string | null>("get_transform_api_key", {
      providerId,
    });
    return key ?? "";
  } catch (err) {
    console.error(`Failed to read the stored API key for ${providerId}:`, err);
    return null;
  }
};

export const useProviderCredential = (
  providerId: string,
  /**
   * Called after a write or delete is durably applied, e.g. to drop caches that
   * were derived from the previous key. Failures never call it.
   */
  onCommitted?: (providerId: string) => void,
): CredentialFieldState => {
  const [entry, setEntry] = useState<FieldEntry>({
    providerId,
    text: "",
    dirty: false,
  });
  const [saving, setSaving] = useState<{
    providerId: string;
    token: number;
  } | null>(null);
  const [error, setError] = useState<{
    providerId: string;
    error: CredentialError;
  } | null>(null);
  const [warning, setWarning] = useState<{
    providerId: string;
    kind: CredentialMigrationWarning | null;
  } | null>(null);

  // Authoritative entry for callbacks; `entry` mirrors it for rendering.
  const entryRef = useRef(entry);
  // Bumped by every provider change, keystroke and commit: a completion whose
  // token no longer matches belongs to a superseded intent and is dropped.
  const tokenRef = useRef(0);
  const onCommittedRef = useRef(onCommitted);

  const applyEntry = useCallback((next: FieldEntry) => {
    entryRef.current = next;
    setEntry(next);
  }, []);

  useEffect(() => {
    onCommittedRef.current = onCommitted;
  });

  const refreshMigrationWarning = useCallback(async (target: string) => {
    try {
      const status = await invoke<RawCredentialStatus>("get_credential_status");
      if (entryRef.current.providerId !== target) return;
      setWarning({
        providerId: target,
        kind: parseMigrationWarning(status, target),
      });
    } catch (err) {
      // Without a fresh status there is nothing to claim; keep the last known
      // warning rather than implying the provider was resolved.
      console.error("Failed to read credential migration status:", err);
    }
  }, []);

  const load = useCallback(
    (target: string) => {
      const token = ++tokenRef.current;
      void (async () => {
        try {
          const key = await invoke<string | null>("get_transform_api_key", {
            providerId: target,
          });
          if (tokenRef.current !== token) return;
          applyEntry({ providerId: target, text: key ?? "", dirty: false });
        } catch (err) {
          if (tokenRef.current !== token) return;
          console.error(
            `Failed to read the stored API key for ${target}:`,
            err,
          );
          applyEntry({ providerId: target, text: "", dirty: false });
          setError({
            providerId: target,
            error: {
              operation: "load",
              detail: err instanceof Error ? err.message : String(err),
            },
          });
        }
      })();
    },
    [applyEntry],
  );

  useEffect(() => {
    tokenRef.current += 1;
    // Rendering already isolates the next provider's field; this resets the
    // stored entry so nothing from the previous provider can be committed later.
    if (entryRef.current.providerId !== providerId) {
      applyEntry({ providerId, text: "", dirty: false });
    }
    setError(null);
    setWarning(null);
    load(providerId);
    void refreshMigrationWarning(providerId);
  }, [providerId, applyEntry, load, refreshMigrationWarning]);

  const setValue = useCallback(
    (value: string) => {
      // Typing supersedes any in-flight read for this provider.
      tokenRef.current += 1;
      applyEntry({ providerId, text: value, dirty: true });
      setError(null);
    },
    [providerId, applyEntry],
  );

  const commit = useCallback(() => {
    const target = providerId;
    const current = entryRef.current;
    // An untouched field must not re-write: only user edits are persisted, so
    // focusing and blurring can never delete a stored key by accident.
    if (current.providerId !== target || !current.dirty) return;

    const key = current.text.trim();
    const deleting = key === "";
    const token = ++tokenRef.current;
    setSaving({ providerId: target, token });
    setError(null);

    void (async () => {
      try {
        const result = await invoke<unknown>(
          deleting ? "delete_transform_api_key" : "set_transform_api_key",
          deleting ? { providerId: target } : { providerId: target, key },
        );
        const envelopeError = errorFromResolvedResult(result);
        if (envelopeError !== null) throw new Error(envelopeError);

        if (tokenRef.current === token) {
          applyEntry({ providerId: target, text: key, dirty: false });
        }
        onCommittedRef.current?.(target);
        void refreshMigrationWarning(target);
      } catch (err) {
        console.error(
          `Failed to ${deleting ? "delete" : "store"} the API key for ${target}:`,
          err,
        );
        if (tokenRef.current === token) {
          setError({
            providerId: target,
            error: {
              operation: deleting ? "delete" : "save",
              detail: err instanceof Error ? err.message : String(err),
            },
          });
        }
        // A failed write also changes backend migration state (conflict,
        // incomplete or failed), so the retained outcome must be re-read.
        void refreshMigrationWarning(target);
      } finally {
        setSaving((prev) => (prev && prev.token === token ? null : prev));
      }
    })();
  }, [providerId, applyEntry, refreshMigrationWarning]);

  return {
    value: entry.providerId === providerId ? entry.text : "",
    isSaving: saving?.providerId === providerId,
    error: error && error.providerId === providerId ? error.error : null,
    migrationWarning:
      warning && warning.providerId === providerId ? warning.kind : null,
    setValue,
    commit,
  };
};
