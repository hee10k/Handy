import { useCallback, useEffect, useRef, useState } from "react";
import { type UnlistenFn } from "@tauri-apps/api/event";
import {
  commands,
  events,
  type AutoInputModelInfo,
  type AutoInputState,
  type Result,
} from "@/bindings";

/** Generated command wrappers report failures in the result; the hook surfaces
 *  them as rejections so every action shares one error path. */
async function unwrap<T>(pending: Promise<Result<T, string>>): Promise<T> {
  const result = await pending;
  if (result.status === "error") throw new Error(result.error);
  return result.data;
}

const INITIAL_STATE: AutoInputState = {
  enabled: false,
  selected_model: null,
  loading: false,
  loaded_model: null,
  error: null,
};

export const useAutoInputSettings = () => {
  const [models, setModels] = useState<AutoInputModelInfo[]>([]);
  const [state, setState] = useState<AutoInputState>(INITIAL_STATE);
  const [targetModelId, setTargetModelId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isUpdating, setIsUpdating] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, { downloaded: number; total: number }>
  >({});
  const lifetime = useRef(0);
  const mounted = useRef(false);
  const modelsQuery = useRef(0);
  const stateQuery = useRef(0);

  const refreshModels = useCallback(async () => {
    const version = lifetime.current;
    const query = ++modelsQuery.current;
    try {
      const list = await unwrap(commands.getAutoInputModels());
      if (
        !mounted.current ||
        lifetime.current !== version ||
        modelsQuery.current !== query
      )
        return;
      setModels(list);
      setTargetModelId((previous) =>
        list.some((model) => model.id === previous)
          ? previous
          : (list[0]?.id ?? null),
      );
      setDownloadProgress((previous) => {
        const next = { ...previous };
        for (const model of list) {
          if (!model.downloading) delete next[model.id];
        }
        return next;
      });
    } catch (err) {
      if (
        mounted.current &&
        lifetime.current === version &&
        modelsQuery.current === query
      ) {
        setCommandError(String(err));
      }
    }
  }, []);

  const refreshState = useCallback(async () => {
    const version = lifetime.current;
    const query = ++stateQuery.current;
    try {
      const next = await unwrap(commands.getAutoInputState());
      if (
        mounted.current &&
        lifetime.current === version &&
        stateQuery.current === query
      )
        setState(next);
    } catch (err) {
      if (
        mounted.current &&
        lifetime.current === version &&
        stateQuery.current === query
      ) {
        setCommandError(String(err));
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const version = ++lifetime.current;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const subscribe = (subscription: Promise<UnlistenFn>) => {
      return subscription
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch((err) => {
          if (!disposed) setCommandError(String(err));
        });
    };
    const subscriptions = [
      subscribe(
        events.autoInputModelProgressPayload.listen(({ payload }) => {
          if (disposed) return;
          setDownloadProgress((previous) => ({
            ...previous,
            [payload.model_id]: {
              downloaded: payload.downloaded,
              total: payload.total,
            },
          }));
        }),
      ),
      subscribe(
        events.autoInputModelStatePayload.listen(({ payload }) => {
          if (disposed) return;
          stateQuery.current += 1;
          setState(payload);
        }),
      ),
      subscribe(
        events.autoInputModelsChangedPayload.listen(() => {
          if (!disposed) void refreshModels();
        }),
      ),
    ];
    setIsLoading(true);
    void Promise.all(subscriptions)
      .then(() => {
        if (!disposed) return Promise.all([refreshModels(), refreshState()]);
      })
      .finally(() => {
        if (!disposed) setIsLoading(false);
      });
    return () => {
      disposed = true;
      if (lifetime.current === version) mounted.current = false;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [refreshModels, refreshState]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, blocking = true) => {
      const version = lifetime.current;
      setCommandError(null);
      if (blocking) setIsUpdating(true);
      try {
        await action();
      } catch (err) {
        if (mounted.current && lifetime.current === version)
          setCommandError(String(err));
      } finally {
        if (mounted.current && lifetime.current === version) {
          await Promise.all([refreshModels(), refreshState()]);
          if (blocking && mounted.current && lifetime.current === version)
            setIsUpdating(false);
        }
      }
    },
    [refreshModels, refreshState],
  );

  return {
    models,
    state,
    targetModelId,
    loadedModelId: state.loaded_model,
    isLoading,
    isUpdating,
    commandError,
    downloadProgress,
    handleBrowseModel: (modelId: string | null) => {
      // Browsing never loads or unloads the backend model.
      if (modelId !== null) setTargetModelId(modelId);
    },
    handleLoadModel: (modelId: string | null) =>
      runAction(() => unwrap(commands.setAutoInputModel(modelId))),
    handleToggleEnabled: (enabled: boolean) =>
      runAction(() => unwrap(commands.setAutoInputEnabled(enabled))),
    handleDownloadModel: (modelId: string) =>
      runAction(() => unwrap(commands.downloadAutoInputModel(modelId)), false),
    handleCancelDownload: (modelId: string) =>
      runAction(
        () => unwrap(commands.cancelAutoInputModelDownload(modelId)),
        false,
      ),
    handleDeleteModel: (modelId: string) =>
      runAction(() => unwrap(commands.deleteAutoInputModel(modelId))),
  };
};
