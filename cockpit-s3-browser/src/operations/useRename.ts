// src/operations/useRename.ts
import { computed, ref } from "vue";
import type { renameObjectStreamed as renameObjectStreamedFn } from "../lib/s3Objects";
import { useTaskCenterStore } from "../stores/taskCenter";

type RenameProgress = { done: number; total: number; bytes: number; size: number };

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  renameObjectStreamed: typeof renameObjectStreamedFn;

  setError?: (msg: string) => void;
  setBusy?: (busy: boolean) => void;

  onRenamed?: (srcKey: string, dstKey: string) => void;
};

export function useRename(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  const renameProgress = ref<RenameProgress | null>(null);
  const renameCancel = ref<null | (() => void)>(null);

  // Keep track of the current task id so cancel/dismiss can target it
  const currentTaskId = ref<string | null>(null);
  const currentTaskName = ref<string>("");

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

  function upsertTask(
    state: "running" | "canceling" | "done" | "failed" | "canceled",
    error?: string,
  ) {
    const id = currentTaskId.value;
    if (!id) return;
  
    const p = renameProgress.value;
  
    const cur =
      p && typeof p.bytes === "number" ? p.bytes : null;
  
    const tot =
      p && typeof p.size === "number" && p.size > 0 ? p.size : null;
  
    taskCenter.upsert({
      id,
      kind: "rename",
      name: currentTaskName.value || "Rename",
      state,
  
      progressText: renameStatusText.value || undefined,
      progressCurrent: cur,
      progressTotal: tot,
      progressPct: typeof renamePct.value === "number" ? renamePct.value : null,
  
      error,
      actions: {
        cancel: () => cancelRename(),
        dismiss: () => dismiss(),
      },
    });
  }
  

  function cancelRename() {
    const id = currentTaskId.value;
    if (!id) return;

    // optimistic UI state
    upsertTask("canceling");

    try {
      renameCancel.value?.();
    } catch {
      // ignore
    }
  }

  function dismiss() {
    const id = currentTaskId.value;
    if (!id) return;

    taskCenter.remove(id);

    currentTaskId.value = null;
    currentTaskName.value = "";
    renameProgress.value = null;
    renameCancel.value = null;
  }

  async function renameFile(srcKey: string, dstKey: string, concurrency = 6) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!srcKey || !dstKey) return;
    if (srcKey === dstKey) return;

    deps.setError?.("");
    deps.setBusy?.(true);

    // Create/replace the global TaskCenter entry for this rename
    const id = `rename:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    currentTaskId.value = id;
    currentTaskName.value = `${srcKey} → ${dstKey}`;

    taskCenter.upsert({
      id,
      kind: "rename",
      name: currentTaskName.value,
      state: "running",
      progressText: "Renaming…",
      progressCurrent: 0,
      progressTotal: null,
      progressPct: null,
      actions: {
        cancel: () => cancelRename(),
        dismiss: () => dismiss(),
      },
    });
    

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
          upsertTask("running");
        } else if (ev.type === "progress") {
          if (!renameProgress.value) {
            renameProgress.value = { done: 0, total: 0, bytes: 0, size: 0 };
          }
          renameProgress.value.done = Number(ev.partsDone ?? renameProgress.value.done);
          renameProgress.value.total = Number(ev.totalParts ?? renameProgress.value.total);
          renameProgress.value.bytes = Number(ev.bytesCopied ?? renameProgress.value.bytes);
          renameProgress.value.size = Number(ev.size ?? renameProgress.value.size);

          upsertTask("running");
        } else if (ev.type === "result") {
          // Clear inline progress UI (page-level)
          renameProgress.value = null;
          renameCancel.value = null;

          if (ev.ok) {
            upsertTask("done");
          } else {
            const msg = ev.error || "Rename canceled/failed";
            // Best-effort: classify cancel vs fail
            const canceled = msg.toLowerCase().includes("cancel");
            upsertTask(canceled ? "canceled" : "failed", msg);
            deps.setError?.(msg);
          }
        }
      },
    });

    renameCancel.value = () => {
      try {
        job.cancel();
      } catch {
        // ignore
      }
    };

    try {
      const res = await job.run;
      if (res.isErr()) {
        const msg = res.error.message || "Rename failed";
        const canceled = msg.toLowerCase().includes("cancel");
        upsertTask(canceled ? "canceled" : "failed", msg);
        deps.setError?.(msg);
        return;
      }

      // success
      upsertTask("done");
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
    dismiss,
  };
}
