// src/operations/useRename.ts
import { computed, ref } from "vue";
import type { renameObjectStreamed as renameObjectStreamedFn } from "../lib/s3Objects";

type RenameProgress = { done: number; total: number; bytes: number; size: number };

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  renameObjectStreamed: typeof renameObjectStreamedFn;

  // UI integration hooks
  setError?: (msg: string) => void;
  setBusy?: (busy: boolean) => void;

  // Called on success so the page can update its rows (or call refresh)
  onRenamed?: (srcKey: string, dstKey: string) => void;
};

export function useRename(deps: Deps) {
  const renameProgress = ref<RenameProgress | null>(null);
  const renameCancel = ref<null | (() => void)>(null);

  const renameStatusText = computed(() => {
    const p = renameProgress.value;
    if (!p) return "";
    if (p.size > 0) {
      const pct = Math.floor((p.bytes / p.size) * 100);
      return `Renaming… ${pct}% (${p.bytes} / ${p.size} bytes)`;
    }
    if (p.total > 0) return `Renaming… ${p.done} / ${p.total} parts`;
    return "Renaming…";
  });

  const renamePct = computed(() => {
    const p = renameProgress.value;
    if (!p || p.size <= 0) return null;
    return Math.max(0, Math.min(100, Math.floor((p.bytes / p.size) * 100)));
  });

  function cancelRename() {
    renameCancel.value?.();
  }

  async function renameFile(srcKey: string, dstKey: string, concurrency = 6) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!srcKey || !dstKey) return;
    if (srcKey === dstKey) return;

    deps.setError?.("");
    deps.setBusy?.(true);

    const job = deps.renameObjectStreamed({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      srcKey,
      dstKey,
      concurrency,
      onEvent: (ev) => {
        if (ev.type === "start") {
          renameProgress.value = {
            done: 0,
            total: Number(ev.totalParts ?? 0),
            bytes: 0,
            size: Number(ev.size ?? 0),
          };
        } else if (ev.type === "progress") {
          if (!renameProgress.value) {
            renameProgress.value = { done: 0, total: 0, bytes: 0, size: 0 };
          }
          renameProgress.value.done = Number(ev.partsDone ?? renameProgress.value.done);
          renameProgress.value.total = Number(ev.totalParts ?? renameProgress.value.total);
          renameProgress.value.bytes = Number(ev.bytesCopied ?? renameProgress.value.bytes);
          renameProgress.value.size = Number(ev.size ?? renameProgress.value.size);
        } else if (ev.type === "result") {
          // Clear progress UI on finish (success or failure)
          renameProgress.value = null;
          renameCancel.value = null;

          if (!ev.ok) deps.setError?.(ev.error || "Rename canceled/failed");
        }
      },
    });

    renameCancel.value = job.cancel;

    try {
      const res = await job.run;
      if (res.isErr()) {
        deps.setError?.(res.error.message);
        return;
      }

      deps.onRenamed?.(srcKey, dstKey);
    } finally {
      deps.setBusy?.(false);
    }
  }

  return {
    renameProgress,
    renameCancel,
    renameStatusText,
    renamePct,

    renameFile,
    cancelRename,
  };
}
