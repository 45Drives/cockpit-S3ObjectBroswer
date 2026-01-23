// src/operations/useRename.ts
import { computed, ref } from "vue";
import type { renameObjectStreamed as renameObjectStreamedFn } from "../lib/s3Objects";
import { useTaskCenterStore } from "../stores/taskCenter";
import { pushNotification, Notification } from "@45drives/houston-common-ui";
import { rateEtaText, updateRateAndEta } from "../lib/helpers";
import type { RateStats } from "../types";

type RenameProgress = {
  done: number;
  total: number;
  bytes: number;
  size: number;
};

type Deps = {
  connectionId: { value: string };
  bucket: { value: string };

  renameObjectStreamed: typeof renameObjectStreamedFn;

  setBusy?: (busy: boolean) => void;

  onRenamed?: (srcKey: string, dstKey: string) => void;
};

export function useRename(deps: Deps) {
  const taskCenter = useTaskCenterStore();

  const renameProgress = ref<RenameProgress | null>(null);
  const renameCancel = ref<null | (() => void)>(null);

  const currentTaskId = ref<string | null>(null);
  const currentTaskName = ref<string>("");

  // Rate/ETA stats for this one rename task
  const rateStats = new Map<string, RateStats>();

  const renamePct = computed(() => {
    const p = renameProgress.value;
    if (!p || p.size <= 0) return null;
    return Math.max(0, Math.min(100, Math.floor((p.bytes / p.size) * 100)));
  });

  function buildProgressText() {
    const id = currentTaskId.value;
    const p = renameProgress.value;

    // If we have byte-based progress, prefer rate+ETA (like upload/download)
    if (id && p && p.size > 0) {
      const re = rateEtaText(rateStats, id);
      const pct = Math.floor((p.bytes / p.size) * 100);
      // Keep a little context without being noisy
      return `Renaming… ${pct}% • ${re}`;
    }

    // Otherwise fall back to parts progress
    if (p && p.total > 0) return `Renaming… ${p.done} / ${p.total} parts`;
    return "Renaming…";
  }

  function upsertTask(
    state: "running" | "canceling" | "done" | "failed" | "canceled",
    error?: string
  ) {
    const id = currentTaskId.value;
    if (!id) return;

    const p = renameProgress.value;

    const cur = p && typeof p.bytes === "number" ? p.bytes : null;
    const tot = p && typeof p.size === "number" && p.size > 0 ? p.size : null;

    taskCenter.upsert({
      id,
      kind: "rename",
      name: currentTaskName.value || "Rename",
      state,

      progressText: buildProgressText(),
      progressCurrent: tot != null ? cur : null,
      progressTotal: tot,
      progressPct: typeof renamePct.value === "number" ? renamePct.value : null,

      error,
      actions: {
        cancel: () => cancelRename(),
        dismiss: () => dismiss(),
      },
    });
  }

  // Throttle expensive UI writes (taskCenter.upsert + reactivity)
  let uiTimer: number | null = null;
  let pendingState: "running" | "canceling" | "done" | "failed" | "canceled" = "running";
  let pendingError: string | undefined;

  function flushUi() {
    uiTimer = null;
    upsertTask(pendingState, pendingError);
    pendingError = undefined;
  }

  function scheduleUi(
    state: "running" | "canceling" | "done" | "failed" | "canceled",
    error?: string
  ) {
    pendingState = state;
    pendingError = error;
    if (uiTimer != null) return;
    uiTimer = window.setTimeout(flushUi, 150); // ~6-7 updates/sec
  }

  function cancelRename() {
    const id = currentTaskId.value;
    if (!id) return;

    scheduleUi("canceling");

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
    rateStats.delete(id);

    if (uiTimer != null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
  }

  async function renameFile(srcKey: string, dstKey: string, concurrency = 6) {
    if (!deps.connectionId.value || !deps.bucket.value) return;
    if (!srcKey || !dstKey) return;
    if (srcKey === dstKey) return;

    deps.setBusy?.(true);

    const id = `rename:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    currentTaskId.value = id;
    currentTaskName.value = `${srcKey} → ${dstKey}`;

    // Reset progress + rate state
    renameProgress.value = null;
    rateStats.delete(id);

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

    let finalized = false;
    const finalize = (state: "done" | "failed" | "canceled", msg?: string) => {
      if (finalized) return;
      finalized = true;

      // stop any pending scheduled UI
      if (uiTimer != null) {
        window.clearTimeout(uiTimer);
        uiTimer = null;
      }

      // Clear inline progress UI (page-level)
      renameProgress.value = null;
      renameCancel.value = null;

      // Final task state (immediate, not throttled)
      upsertTask(state, msg);

      // Cleanup stats
      rateStats.delete(id);

      if (state === "done") {
        console.log(`[rename] completed ${srcKey} → ${dstKey}`);
        pushNotification(
          new Notification(
            "Rename completed",
            `Rename completed ${srcKey} → ${dstKey}`,
            "success",
            5000
          )
        );
        deps.onRenamed?.(srcKey, dstKey);
        return;
      }

      const em = msg || (state === "canceled" ? "Rename canceled" : "Rename failed");
      if (state === "canceled") {
        console.log(`[rename] canceled ${srcKey} → ${dstKey}: ${em}`);
        pushNotification(
          new Notification(
            "Rename canceled",
            `Rename canceled ${srcKey} → ${dstKey}`,
            "error",
            5000
          )
        );
      } else {
        console.error(`[rename] failed ${srcKey} → ${dstKey}: ${em}`);
        pushNotification(
          new Notification(
            "Rename failed",
            `Rename failed ${srcKey} → ${dstKey}`,
            "error",
            5000
          )
        );
      }
    };

    const job = deps.renameObjectStreamed({
      connectionId: deps.connectionId.value,
      bucket: deps.bucket.value,
      srcKey,
      dstKey,
      concurrency,
      onEvent: (ev) => {
        if (ev.type === "start") {
          const total = Number(ev.totalParts ?? 0);
          const size = Number(ev.size ?? 0);

          renameProgress.value = {
            done: 0,
            total: Number.isFinite(total) ? total : 0,
            bytes: 0,
            size: Number.isFinite(size) ? size : 0,
          };

          // create initial rate state when we know total size
          if (renameProgress.value.size > 0) {
            updateRateAndEta(rateStats, id, 0, renameProgress.value.size);
          }

          scheduleUi("running");
          return;
        }

        if (ev.type === "progress") {
          if (!renameProgress.value) {
            renameProgress.value = { done: 0, total: 0, bytes: 0, size: 0 };
          }

          const done = Number(ev.partsDone ?? renameProgress.value.done);
          const total = Number(ev.totalParts ?? renameProgress.value.total);
          const bytes = Number(ev.bytesCopied ?? renameProgress.value.bytes);
          const size = Number(ev.size ?? renameProgress.value.size);

          renameProgress.value.done = Number.isFinite(done) ? done : renameProgress.value.done;
          renameProgress.value.total = Number.isFinite(total) ? total : renameProgress.value.total;
          renameProgress.value.bytes = Number.isFinite(bytes) ? bytes : renameProgress.value.bytes;
          renameProgress.value.size = Number.isFinite(size) ? size : renameProgress.value.size;

          // rate/eta if we have total size
          if (renameProgress.value.size > 0) {
            updateRateAndEta(rateStats, id, renameProgress.value.bytes, renameProgress.value.size);
          }

          scheduleUi("running");
          return;
        }

        if (ev.type === "result") {
          if (ev.ok) {
            finalize("done");
          } else {
            const msg = ev.error || "Rename canceled/failed";
            const canceled = msg.toLowerCase().includes("cancel");
            finalize(canceled ? "canceled" : "failed", msg);
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

      // If stream didn't send a final "result" event, finalize here.
      if (res.isErr()) {
        const msg = res.error.message || "Rename failed";
        const canceled = msg.toLowerCase().includes("cancel");
        finalize(canceled ? "canceled" : "failed", msg);
        return;
      }

      finalize("done");
    } finally {
      deps.setBusy?.(false);
    }
  }

  return {
    renameProgress,
    renameCancel,
    renamePct,

    renameFile,
    cancelRename,
    dismiss,
  };
}
